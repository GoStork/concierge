import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { hasProviderRole } from "@shared/roles";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Link2, Copy, Check, Calendar, Clock, Globe, Video, FileText,
  Plus, Trash2, Wifi, WifiOff, CalendarPlus, Ban, CalendarCheck, AlertTriangle, RefreshCw, ChevronsUpDown, Search,
} from "lucide-react";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DURATION_OPTIONS = [15, 30, 45, 60];
const NOTICE_OPTIONS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "24 hours" },
  { value: 2880, label: "48 hours" },
];
const BUFFER_OPTIONS = [
  { value: 0, label: "None" },
  { value: 5, label: "5 min" },
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
];

function GoogleIcon({ className }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 48 48" className={className}>
      <path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107"/>
      <path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00"/>
      <path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50"/>
      <path d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2"/>
    </svg>
  );
}

function MicrosoftIcon({ className }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <rect x="1" y="1" width="10.5" height="10.5" fill="#f25022" />
      <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7fba00" />
      <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00a4ef" />
      <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#ffb900" />
    </svg>
  );
}

function AppleIcon({ className }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#333333">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
    </svg>
  );
}

const CALENDAR_PROVIDERS = [
  { id: "google", name: "Google", desc: "Google Calendar", icon: GoogleIcon, color: "#4285f4", bg: "#eef3ff" },
  { id: "apple", name: "Apple", desc: "iCloud Calendar", icon: AppleIcon, color: "#333333", bg: "#f5f5f5" },
  { id: "microsoft", name: "Microsoft", desc: "Outlook / Office 365", icon: MicrosoftIcon, color: "#0078d4", bg: "#f0f6ff" },
];

function getUtcOffset(tz: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    return offsetPart?.value?.replace("GMT", "UTC") || "";
  } catch {
    return "";
  }
}

function formatTzLabel(tz: string): string {
  const offset = getUtcOffset(tz);
  const city = tz.split("/").pop()?.replace(/_/g, " ") || tz;
  return `(${offset}) ${tz.replace(/_/g, " ")}`;
}

type AvailSlot = {
  id?: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isActive: boolean;
};

type ConfigData = {
  id: string;
  timezone: string;
  meetingDuration: number;
  minBookingNotice: number;
  bufferTime: number;
  meetingLink: string | null;
  defaultSubject: string | null;
  bookingPageSlug: string | null;
  calendarProvider: string | null;
  calendarConnected: boolean;
  autoConsentRecording: boolean;
  availabilitySlots: AvailSlot[];
};

type Override = {
  id: string;
  date: string;
  isAvailable: boolean;
  slots: { startTime: string; endTime: string }[] | null;
  label: string | null;
};

type CalendarConnectionType = {
  id: string;
  provider: string;
  label: string | null;
  email: string | null;
  isConflictCalendar: boolean;
  isBookingCalendar: boolean;
  color: string;
  connected: boolean;
};

export function CalendarSettings() {
  const { toast } = useToast();
  const { user: authUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const [connectEmail, setConnectEmail] = useState("");
  const [connectAppPassword, setConnectAppPassword] = useState("");
  const [connectStep, setConnectStep] = useState<"pick" | "google-calendars" | "microsoft-calendars" | "email" | "apple-connect" | "caldav-calendars">("pick");
  const [connectingGoogleEmail, setConnectingGoogleEmail] = useState<string | null>(null);
  const [connectingMicrosoftEmail, setConnectingMicrosoftEmail] = useState<string | null>(null);
  const [caldavCalendars, setCaldavCalendars] = useState<any[]>([]);
  const [caldavConnectingEmail, setCaldavConnectingEmail] = useState<string | null>(null);
  const [caldavConnecting, setCaldavConnecting] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedVideo, setCopiedVideo] = useState(false);
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [microsoftConnecting, setMicrosoftConnecting] = useState(false);
  const [deleteConnId, setDeleteConnId] = useState<string | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState("");
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const [conflictCalendarIds, setConflictCalendarIds] = useState<string[]>([]);

  const [timezone, setTimezone] = useState("");
  const [tzSearchOpen, setTzSearchOpen] = useState(false);
  const [meetingDuration, setMeetingDuration] = useState(30);
  const [minBookingNotice, setMinBookingNotice] = useState(15);
  const [bufferTime, setBufferTime] = useState(0);
  const [meetingLink, setMeetingLink] = useState("");
  const [defaultSubject, setDefaultSubject] = useState("");
  const [bookingPageSlug, setBookingPageSlug] = useState("");
  const [slots, setSlots] = useState<AvailSlot[]>([]);
  const [autoConsentRecording, setAutoConsentRecording] = useState(true);

  const [overrideDate, setOverrideDate] = useState("");
  const [overrideIsAvailable, setOverrideIsAvailable] = useState(true);
  const [overrideLabel, setOverrideLabel] = useState("");
  const [overrideSlots, setOverrideSlots] = useState<{ startTime: string; endTime: string }[]>([
    { startTime: "09:00", endTime: "17:00" },
  ]);

  useEffect(() => {
    if (searchParams.get("connect") === "true") {
      setConnectDialogOpen(true);
      setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete("connect"); return next; }, { replace: true });
    }
  }, []);

  const { data: config, isLoading } = useQuery<ConfigData>({
    queryKey: ["/api/calendar/config"],
    queryFn: async () => {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(`/api/calendar/config?browserTimezone=${encodeURIComponent(browserTz)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch config");
      return res.json();
    },
  });

  const { data: overrides } = useQuery<Override[]>({
    queryKey: ["/api/calendar/overrides"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/overrides", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch overrides");
      return res.json();
    },
  });

  const { data: connections } = useQuery<CalendarConnectionType[]>({
    queryKey: ["/api/calendar/connections"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/connections", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch connections");
      return res.json();
    },
  });

  const { data: googleStatus } = useQuery<{ configured: boolean; connected: boolean }>({
    queryKey: ["/api/calendar/google/status"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/google/status", { credentials: "include" });
      if (!res.ok) return { configured: false, connected: false };
      return res.json();
    },
  });

  const hasGoogleConnection = (connections || []).some((c: any) => c.provider === "google" && c.connected);
  const hasMicrosoftConnection = (connections || []).some((c: any) => c.provider === "microsoft" && c.connected);

  const { data: microsoftStatus } = useQuery<{ configured: boolean; connected: boolean }>({
    queryKey: ["/api/calendar/microsoft/status"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/microsoft/status", { credentials: "include" });
      if (!res.ok) return { configured: false, connected: false };
      return res.json();
    },
  });

  const { data: healthResult } = useQuery<{ healthy: boolean; error?: string }>({
    queryKey: ["/api/calendar/google/health"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/google/health", { credentials: "include" });
      if (!res.ok) return { healthy: false, error: "Failed to check connection health" };
      const result = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      return result;
    },
    enabled: hasGoogleConnection,
    refetchOnWindowFocus: false,
    staleTime: 60000,
  });

  const { data: microsoftHealthResult } = useQuery<{ healthy: boolean; error?: string }>({
    queryKey: ["/api/calendar/microsoft/health"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/microsoft/health", { credentials: "include" });
      if (!res.ok) return { healthy: false, error: "Failed to check connection health" };
      const result = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      return result;
    },
    enabled: hasMicrosoftConnection,
    refetchOnWindowFocus: false,
    staleTime: 60000,
  });

  const { data: googleCalendars, refetch: refetchGoogleCalendars } = useQuery<any[]>({
    queryKey: ["/api/calendar/google/calendars", connectingGoogleEmail],
    queryFn: async () => {
      const url = connectingGoogleEmail
        ? `/api/calendar/google/calendars?email=${encodeURIComponent(connectingGoogleEmail)}`
        : "/api/calendar/google/calendars";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: connectStep === "google-calendars",
  });

  const { data: microsoftCalendars, refetch: refetchMicrosoftCalendars } = useQuery<any[]>({
    queryKey: ["/api/calendar/microsoft/calendars", connectingMicrosoftEmail],
    queryFn: async () => {
      const url = connectingMicrosoftEmail
        ? `/api/calendar/microsoft/calendars?email=${encodeURIComponent(connectingMicrosoftEmail)}`
        : "/api/calendar/microsoft/calendars";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: connectStep === "microsoft-calendars",
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google_connected") === "1") {
      const mode = params.get("mode");
      const returnedEmail = params.get("email") || null;
      if (mode === "existing") {
        toast({ title: `Google Calendar tokens refreshed${returnedEmail ? ` for ${returnedEmail}` : ""}!`, variant: "success" });
      } else {
        toast({ title: `Google account${returnedEmail ? ` (${returnedEmail})` : ""} connected! Select calendars to sync.`, variant: "success" });
        setConnectingGoogleEmail(returnedEmail);
        setConnectDialogOpen(true);
        setConnectStep("google-calendars");
        setConnectProvider("google");
        setSelectedCalendarIds([]);
      }
      window.history.replaceState({}, "", window.location.pathname + (params.get("tab") ? "?tab=" + params.get("tab") : ""));
    }
    if (params.get("google_error")) {
      toast({ title: "Google Calendar Error", description: decodeURIComponent(params.get("google_error") || ""), variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname + (params.get("tab") ? "?tab=" + params.get("tab") : ""));
    }
    if (params.get("microsoft_connected") === "1") {
      const mode = params.get("mode");
      const returnedEmail = params.get("email") || null;
      if (mode === "existing") {
        toast({ title: `Microsoft Calendar tokens refreshed${returnedEmail ? ` for ${returnedEmail}` : ""}!`, variant: "success" });
      } else {
        toast({ title: `Microsoft account${returnedEmail ? ` (${returnedEmail})` : ""} connected! Select calendars to sync.`, variant: "success" });
        setConnectingMicrosoftEmail(returnedEmail);
        setConnectDialogOpen(true);
        setConnectStep("microsoft-calendars");
        setConnectProvider("microsoft");
        setSelectedCalendarIds([]);
      }
      window.history.replaceState({}, "", window.location.pathname + (params.get("tab") ? "?tab=" + params.get("tab") : ""));
    }
    if (params.get("microsoft_error")) {
      toast({ title: "Microsoft Calendar Error", description: decodeURIComponent(params.get("microsoft_error") || ""), variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname + (params.get("tab") ? "?tab=" + params.get("tab") : ""));
    }
  }, []);

  useEffect(() => {
    if (config) {
      setTimezone(config.timezone);
      setMeetingDuration(config.meetingDuration);
      setMinBookingNotice(config.minBookingNotice);
      setBufferTime(config.bufferTime);
      setMeetingLink(config.meetingLink || "");
      setDefaultSubject(config.defaultSubject || "");
      setBookingPageSlug(config.bookingPageSlug || "");
      setSlots(config.availabilitySlots || []);
      setAutoConsentRecording(config.autoConsentRecording ?? true);
    }
  }, [config]);

  const saveConfigMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", "/api/calendar/config", {
        timezone, meetingDuration, minBookingNotice, bufferTime,
        meetingLink: meetingLink || null,
        defaultSubject: defaultSubject || null,
        bookingPageSlug: bookingPageSlug || null,
        autoConsentRecording,
      });
      await apiRequest("PUT", "/api/calendar/availability", {
        slots: slots.map((s) => ({
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          isActive: s.isActive,
        })),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/config"] });
      toast({ title: "Calendar settings saved", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const addConnectionMutation = useMutation({
    mutationFn: async ({ provider, email, calendarIds, googleEmail, microsoftEmail, conflictCalendarIds: cIds }: { provider: string; email?: string; calendarIds?: string[]; googleEmail?: string; microsoftEmail?: string; conflictCalendarIds?: string[] }) => {
      if (provider === "google") {
        const res = await apiRequest("POST", "/api/calendar/google/connect", { calendarIds, email: googleEmail, conflictCalendarIds: cIds });
        return res.json();
      }
      if (provider === "microsoft") {
        const res = await apiRequest("POST", "/api/calendar/microsoft/connect", { calendarIds, email: microsoftEmail, conflictCalendarIds: cIds });
        return res.json();
      }
      await apiRequest("POST", "/api/calendar/connections", { provider, email: email || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/google/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/microsoft/status"] });
      setConnectDialogOpen(false);
      setConnectProvider(null);
      setConnectEmail("");
      setConnectAppPassword("");
      setConnectStep("pick");
      setSelectedCalendarIds([]);
      setConflictCalendarIds([]);
      setConnectingGoogleEmail(null);
      setConnectingMicrosoftEmail(null);
      setCaldavCalendars([]);
      setCaldavConnectingEmail(null);
      toast({ title: "Calendars connected", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const caldavSelectMutation = useMutation({
    mutationFn: async ({ provider, email, calendarIds, conflictCalendarIds: cIds }: { provider: string; email: string; calendarIds: string[]; conflictCalendarIds?: string[] }) => {
      const res = await apiRequest("POST", "/api/calendar/caldav/calendars/select", { provider, email, calendarIds, conflictCalendarIds: cIds });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      setConnectDialogOpen(false);
      setConnectProvider(null);
      setConnectEmail("");
      setConnectAppPassword("");
      setConnectStep("pick");
      setSelectedCalendarIds([]);
      setConflictCalendarIds([]);
      setCaldavCalendars([]);
      setCaldavConnectingEmail(null);
      toast({ title: "Calendars connected", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateConnectionMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest("PATCH", `/api/calendar/connections/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
    },
  });

  const colorDebounceTimers = {} as Record<string, any>;
  function updateConnectionColor(connId: string, color: string) {
    clearTimeout(colorDebounceTimers[connId]);
    queryClient.setQueryData(["/api/calendar/connections"], (old: any) =>
      old ? old.map((c: any) => c.id === connId ? { ...c, color } : c) : old
    );
    colorDebounceTimers[connId] = setTimeout(() => {
      updateConnectionMutation.mutate({ id: connId, data: { color } });
    }, 400);
  }

  const deleteConnectionMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/calendar/connections/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      toast({ title: "Calendar disconnected", variant: "success" });
    },
  });

  const upsertOverrideMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/calendar/overrides", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/overrides"] });
      setOverrideDialogOpen(false);
      resetOverrideForm();
      toast({ title: "Date override saved", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteOverrideMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/calendar/overrides/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/overrides"] });
      toast({ title: "Override removed", variant: "success" });
    },
  });

  function resetOverrideForm() {
    setOverrideDate("");
    setOverrideIsAvailable(true);
    setOverrideLabel("");
    setOverrideSlots([{ startTime: "09:00", endTime: "17:00" }]);
  }

  function toggleDay(dayOfWeek: number) {
    const daySlots = slots.filter((s) => s.dayOfWeek === dayOfWeek);
    if (daySlots.length === 0) {
      setSlots([...slots, { dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true }]);
    } else {
      const allActive = daySlots.every((s) => s.isActive);
      setSlots(
        slots.map((s) => (s.dayOfWeek === dayOfWeek ? { ...s, isActive: !allActive } : s))
      );
    }
  }

  function addSlotToDay(dayOfWeek: number) {
    setSlots([...slots, { dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true }]);
  }

  function removeSlot(index: number) {
    setSlots(slots.filter((_, i) => i !== index));
  }

  function updateSlot(index: number, field: string, value: string) {
    setSlots(slots.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }

  function copyBookingLink() {
    const url = `${window.location.origin}/book/${bookingPageSlug}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatOverrideDate(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const bookingUrl = `${window.location.origin}/book/${bookingPageSlug}`;
  const hasConnections = connections && connections.length > 0;

  return (
    <div className="space-y-6">
      <Card className="p-6" data-testid="calendar-connect-section">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {hasConnections ? (
              <Wifi className="w-5 h-5 text-[hsl(var(--brand-success))]" />
            ) : (
              <WifiOff className="w-5 h-5 text-muted-foreground" />
            )}
            <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Connected Calendars</h2>
          </div>
          <Button size="sm" variant="outline" onClick={() => setConnectDialogOpen(true)} data-testid="button-connect-calendar">
            <CalendarPlus className="w-4 h-4 mr-1" /> Connect
          </Button>
        </div>

        {hasConnections ? (
          <div className="space-y-3">
            {connections!.map((conn) => {
              const providerInfo = CALENDAR_PROVIDERS.find((p) => p.id === conn.provider);
              return (
                <div
                  key={conn.id}
                  className="flex items-center gap-3 p-3 rounded-[var(--radius)] border border-border/30 bg-secondary/10"
                  data-testid={`connection-${conn.id}`}
                >
                  <div
                    className="w-3 h-8 rounded-full shrink-0"
                    style={{ backgroundColor: conn.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {providerInfo ? <providerInfo.icon className="w-4 h-4" style={{ color: providerInfo.color }} /> : <Calendar className="w-4 h-4" />}
                      {editingLabelId === conn.id ? (
                        <Input
                          autoFocus
                          value={editingLabelValue}
                          onChange={(e) => setEditingLabelValue(e.target.value)}
                          onBlur={() => {
                            const trimmed = editingLabelValue.trim();
                            if (trimmed && trimmed !== conn.label) {
                              updateConnectionMutation.mutate({ id: conn.id, data: { label: trimmed } });
                            }
                            setEditingLabelId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditingLabelId(null);
                          }}
                          className="h-6 text-sm font-ui px-1 py-0 w-auto max-w-[200px]"
                          data-testid={`input-label-${conn.id}`}
                        />
                      ) : (
                        <span
                          className="text-sm font-ui truncate cursor-pointer hover:text-primary hover:underline"
                          onClick={() => { setEditingLabelId(conn.id); setEditingLabelValue(conn.label || providerInfo?.name || ""); }}
                          data-testid={`label-${conn.id}`}
                        >
                          {conn.label || providerInfo?.name}
                        </span>
                      )}
                    </div>
                    {conn.email && (
                      <p className="text-xs text-muted-foreground truncate">{conn.email}</p>
                    )}
                    {conn.tokenValid === false && (conn.provider === "google" || conn.provider === "microsoft") && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--brand-warning))] shrink-0" />
                        <span className="text-xs text-[hsl(var(--brand-warning))] font-ui">Connection expired</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs text-[hsl(var(--brand-warning))] hover:text-[hsl(var(--brand-warning))] underline"
                          onClick={async () => {
                            const isMs = conn.provider === "microsoft";
                            if (isMs) setMicrosoftConnecting(true); else setGoogleConnecting(true);
                            try {
                              const hint = conn.email ? `?login_hint=${encodeURIComponent(conn.email)}` : "";
                              const res = await fetch(`/api/calendar/${conn.provider}/auth-url${hint}`, { credentials: "include" });
                              const { url } = await res.json();
                              if (url) window.location.href = url;
                            } catch {
                              toast({ title: "Failed to start reconnection", variant: "destructive" });
                              if (isMs) setMicrosoftConnecting(false); else setGoogleConnecting(false);
                            }
                          }}
                          disabled={googleConnecting || microsoftConnecting}
                          data-testid={`button-reconnect-${conn.id}`}
                        >
                          {(conn.provider === "google" ? googleConnecting : microsoftConnecting) ? <Loader2 className="w-3 h-3 animate-spin" /> : "Reconnect"}
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <Switch
                        checked={conn.isConflictCalendar}
                        onCheckedChange={(v) => updateConnectionMutation.mutate({ id: conn.id, data: { isConflictCalendar: v } })}
                        data-testid={`switch-conflict-${conn.id}`}
                      />
                      <span className="text-xs text-muted-foreground">Check conflicts</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Switch
                        checked={conn.isBookingCalendar}
                        onCheckedChange={(v) => {
                          if (v) updateConnectionMutation.mutate({ id: conn.id, data: { isBookingCalendar: true } });
                        }}
                        disabled={conn.isBookingCalendar}
                        data-testid={`switch-booking-${conn.id}`}
                      />
                      <span className="text-xs text-muted-foreground">Booking</span>
                    </div>
                    <button
                      type="button"
                      className="relative w-5 h-5 rounded shrink-0 cursor-pointer border border-border/50 hover:ring-2 hover:ring-primary/30 transition-all"
                      style={{ backgroundColor: conn.color }}
                      onClick={() => document.getElementById(`color-conn-${conn.id}`)?.click()}
                      data-testid={`button-color-${conn.id}`}
                    />
                    <input
                      id={`color-conn-${conn.id}`}
                      type="color"
                      value={conn.color}
                      onChange={(e) => updateConnectionColor(conn.id, e.target.value)}
                      className="sr-only"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                      onClick={() => setDeleteConnId(conn.id)}
                      disabled={deleteConnectionMutation.isPending}
                      data-testid={`button-disconnect-${conn.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect your calendars to sync events and prevent double-bookings. Events from connected calendars will appear as busy blocks.
          </p>
        )}
      </Card>

      <Card className="p-6" data-testid="booking-link-section">
        <div className="flex items-center gap-2 mb-4">
          <Link2 className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Your Calendar Link</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Share this link with anyone to let them book time with you. It can be embedded on websites or shared via email.
        </p>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 flex items-center bg-secondary/30 border border-border/50 rounded-[var(--radius)] px-3 py-2">
            <span className="text-sm text-muted-foreground mr-1 shrink-0">/book/</span>
            <Input
              value={bookingPageSlug}
              onChange={(e) => setBookingPageSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              className="border-0 bg-transparent p-0 h-auto text-sm font-ui focus-visible:ring-0 shadow-none"
              data-testid="input-booking-slug"
            />
          </div>
          <Button variant="outline" size="sm" onClick={copyBookingLink} data-testid="button-copy-link">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </Button>
        </div>
        {bookingPageSlug && (
          <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline break-all" data-testid="link-booking-url">{bookingUrl}</a>
        )}
      </Card>

      <Card className="p-6" data-testid="scheduling-rules-section">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Scheduling Rules</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Popover open={tzSearchOpen} onOpenChange={setTzSearchOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={tzSearchOpen}
                  className="w-full justify-between font-normal h-10"
                  data-testid="select-timezone"
                >
                  <span className="truncate">
                    {timezone ? formatTzLabel(timezone) : "Select timezone..."}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search by city, country, or region..." data-testid="input-timezone-search" />
                  <CommandList>
                    <CommandEmpty>No timezone found.</CommandEmpty>
                    <CommandGroup className="max-h-[300px] overflow-auto">
                      {Intl.supportedValuesOf("timeZone").map((tz) => (
                        <CommandItem
                          key={tz}
                          value={`${tz} ${tz.replace(/_/g, " ")} ${getUtcOffset(tz)}`}
                          onSelect={() => {
                            setTimezone(tz);
                            setTzSearchOpen(false);
                          }}
                          data-testid={`timezone-option-${tz}`}
                        >
                          <Check className={`mr-2 h-4 w-4 ${timezone === tz ? "opacity-100" : "opacity-0"}`} />
                          {formatTzLabel(tz)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label>Meeting Duration</Label>
            <Select value={String(meetingDuration)} onValueChange={(v) => setMeetingDuration(Number(v))}>
              <SelectTrigger data-testid="select-duration">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>{d} minutes</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Minimum Notice</Label>
            <Select value={String(minBookingNotice)} onValueChange={(v) => setMinBookingNotice(Number(v))}>
              <SelectTrigger data-testid="select-notice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTICE_OPTIONS.map((n) => (
                  <SelectItem key={n.value} value={String(n.value)}>{n.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Buffer Between Meetings</Label>
            <Select value={String(bufferTime)} onValueChange={(v) => setBufferTime(Number(v))}>
              <SelectTrigger data-testid="select-buffer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUFFER_OPTIONS.map((b) => (
                  <SelectItem key={b.value} value={String(b.value)}>{b.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Label className="flex items-center gap-1">
            <Video className="w-4 h-4" /> Meeting Link
          </Label>
          {authUser?.dailyRoomUrl ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 min-w-0 border rounded-[var(--radius)] px-3 py-2 bg-muted/30">
                <Video className="w-4 h-4 text-primary shrink-0" />
                <a href={authUser.dailyRoomUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate" data-testid="link-video-conference-room">
                  {authUser.dailyRoomUrl}
                </a>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(authUser.dailyRoomUrl!);
                  setCopiedVideo(true);
                  setTimeout(() => setCopiedVideo(false), 2000);
                }}
                data-testid="button-copy-video-link"
              >
                {copiedVideo ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          ) : (
            <Input
              value={meetingLink}
              onChange={(e) => setMeetingLink(e.target.value)}
              placeholder="https://meet.google.com/xxx-xxxx-xxx or https://zoom.us/j/xxxxx"
              data-testid="input-meeting-link"
            />
          )}
          <p className="text-xs text-muted-foreground">This link will be attached to all your bookings automatically.</p>
        </div>

        <div className="mt-4 space-y-2">
          <Label className="flex items-center gap-1">
            <FileText className="w-4 h-4" /> Default Meeting Subject
          </Label>
          <Input
            value={defaultSubject}
            onChange={(e) => setDefaultSubject(e.target.value)}
            placeholder="e.g. GoStork Consultation"
            data-testid="input-default-subject"
          />
          <p className="text-xs text-muted-foreground">Default subject line used for booking page appointments and pre-filled when creating new meetings.</p>
        </div>

        {authUser && (hasProviderRole(authUser.roles || []) || (authUser.roles || []).includes("GOSTORK_ADMIN")) && (
        <div className="mt-4 pt-4 border-t border-border/30">
          <div className="flex items-start gap-3">
            <Checkbox
              id="auto-consent-recording"
              checked={autoConsentRecording}
              onCheckedChange={(checked) => setAutoConsentRecording(!!checked)}
              className="mt-0.5"
              data-testid="checkbox-auto-consent-recording"
            />
            <div>
              <label htmlFor="auto-consent-recording" className="text-sm font-ui cursor-pointer select-none">
                Always record & transcribe my calls
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                When enabled, calls will be recorded and transcribed automatically without asking each time. Uncheck to be prompted before every meeting.
              </p>
            </div>
          </div>
        </div>
        )}
      </Card>

      <Card className="p-6" data-testid="availability-section">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Weekly Availability</h2>
        </div>

        <div className="space-y-3">
          {DAYS.map((dayName, dayIndex) => {
            const daySlots = slots
              .map((s, originalIndex) => ({ ...s, originalIndex }))
              .filter((s) => s.dayOfWeek === dayIndex);
            const isActive = daySlots.length > 0 && daySlots.some((s) => s.isActive);

            return (
              <div key={dayIndex} className="flex items-start gap-3 py-2 border-b border-border/30 last:border-0" data-testid={`availability-day-${dayIndex}`}>
                <div className="flex items-center gap-2 w-28 pt-1.5 shrink-0">
                  <Switch
                    checked={isActive}
                    onCheckedChange={() => toggleDay(dayIndex)}
                    data-testid={`switch-day-${dayIndex}`}
                  />
                  <span className={`text-sm font-ui ${isActive ? "" : "text-muted-foreground"}`}>
                    {dayName.slice(0, 3)}
                  </span>
                </div>

                <div className="flex-1 space-y-2">
                  {isActive ? (
                    <>
                      {daySlots.filter((s) => s.isActive).map((slot, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={slot.startTime}
                            onChange={(e) => updateSlot(slot.originalIndex, "startTime", e.target.value)}
                            className="w-28 text-sm"
                            data-testid={`input-start-${dayIndex}-${i}`}
                          />
                          <span className="text-muted-foreground text-sm">to</span>
                          <Input
                            type="time"
                            value={slot.endTime}
                            onChange={(e) => updateSlot(slot.originalIndex, "endTime", e.target.value)}
                            className="w-28 text-sm"
                            data-testid={`input-end-${dayIndex}-${i}`}
                          />
                          {daySlots.filter((s) => s.isActive).length > 1 && (
                            <Button variant="ghost" size="sm" onClick={() => removeSlot(slot.originalIndex)} className="text-muted-foreground hover:text-destructive h-8 w-8 p-0">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      ))}
                      <Button variant="ghost" size="sm" onClick={() => addSlotToDay(dayIndex)} className="text-xs text-primary h-7 px-2">
                        <Plus className="w-3 h-3 mr-1" /> Add block
                      </Button>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground pt-1.5">Unavailable</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-6" data-testid="date-overrides-section">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CalendarCheck className="w-5 h-5 text-primary" />
            <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wider">Date Overrides</h2>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              resetOverrideForm();
              setOverrideDialogOpen(true);
            }}
            data-testid="button-add-override"
          >
            <Plus className="w-4 h-4 mr-1" /> Add Override
          </Button>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Override your weekly hours for specific dates. Add custom availability or mark days as unavailable.
        </p>

        {overrides && overrides.length > 0 ? (
          <div className="space-y-2">
            {overrides.map((ov) => (
              <div
                key={ov.id}
                className="flex items-center gap-3 p-3 rounded-[var(--radius)] border border-border/30 bg-secondary/10"
                data-testid={`override-${ov.id}`}
              >
                <div className={`w-2 h-8 rounded-full shrink-0 ${ov.isAvailable ? "bg-[hsl(var(--brand-success))]" : "bg-destructive/60"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-ui">{formatOverrideDate(ov.date)}</span>
                    {ov.label && (
                      <span className="text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">
                        {ov.label}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {ov.isAvailable ? (
                      ov.slots && ov.slots.length > 0
                        ? ov.slots.map((s) => `${s.startTime} – ${s.endTime}`).join(", ")
                        : "Open (uses weekly hours)"
                    ) : (
                      "Unavailable"
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                  onClick={() => deleteOverrideMutation.mutate(ov.id)}
                  disabled={deleteOverrideMutation.isPending}
                  data-testid={`button-delete-override-${ov.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-4 text-sm text-muted-foreground border border-dashed border-border/50 rounded-[var(--radius)]">
            No date overrides set. Your weekly availability applies to all dates.
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={() => saveConfigMutation.mutate()}
          disabled={saveConfigMutation.isPending}
          data-testid="button-save-calendar-settings"
        >
          {saveConfigMutation.isPending ? "Saving..." : "Save"}
        </Button>
      </div>

      <Dialog open={connectDialogOpen} onOpenChange={(open) => {
        setConnectDialogOpen(open);
        if (!open) { setConnectProvider(null); setConnectEmail(""); setConnectAppPassword(""); setConnectStep("pick"); setCaldavCalendars([]); setCaldavConnectingEmail(null); setCaldavConnecting(false); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {connectStep === "pick" && "Connect a Calendar"}
              {connectStep === "google-calendars" && "Select Google Calendar"}
              {connectStep === "microsoft-calendars" && "Select Outlook Calendar"}
              {connectStep === "email" && "Enter Calendar Account"}
              {connectStep === "apple-connect" && "Connect Your Apple Calendar"}
              {connectStep === "caldav-calendars" && "Select Apple Calendar"}
            </DialogTitle>
          </DialogHeader>

          {connectStep === "pick" && (
            <>
              <p className="text-sm text-muted-foreground">
                Select a calendar provider. Events from connected calendars will block your booking availability.
              </p>
              <div className="grid grid-cols-3 gap-3 py-3">
                {CALENDAR_PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    disabled={googleConnecting || microsoftConnecting}
                    onClick={async () => {
                      setConnectProvider(p.id);
                      if (p.id === "google") {
                        if (googleStatus?.configured) {
                          setGoogleConnecting(true);
                          try {
                            const res = await fetch("/api/calendar/google/auth-url", { credentials: "include" });
                            if (!res.ok) throw new Error("Failed to get auth URL");
                            const { url } = await res.json();
                            window.location.href = url;
                          } catch (e: any) {
                            toast({ title: "Error", description: e.message, variant: "destructive" });
                            setGoogleConnecting(false);
                          }
                        } else {
                          toast({ title: "Google Calendar not configured", description: "Google OAuth credentials need to be set up by an administrator.", variant: "destructive" });
                          setConnectProvider(null);
                        }
                      } else if (p.id === "microsoft") {
                        if (microsoftStatus?.configured) {
                          setMicrosoftConnecting(true);
                          try {
                            const res = await fetch("/api/calendar/microsoft/auth-url", { credentials: "include" });
                            if (!res.ok) throw new Error("Failed to get auth URL");
                            const { url } = await res.json();
                            window.location.href = url;
                          } catch (e: any) {
                            toast({ title: "Error", description: e.message, variant: "destructive" });
                            setMicrosoftConnecting(false);
                          }
                        } else {
                          toast({ title: "Microsoft Calendar not configured", description: "Microsoft OAuth credentials need to be set up by an administrator.", variant: "destructive" });
                          setConnectProvider(null);
                        }
                      } else if (p.id === "apple") {
                        setConnectStep("apple-connect");
                      }
                    }}
                    className="flex flex-col items-center gap-3 p-5 rounded-[var(--radius)] border-2 transition-all text-center group border-border/40 hover:border-primary/30 hover:shadow-md cursor-pointer disabled:opacity-50"
                    style={{ backgroundColor: p.bg }}
                    data-testid={`button-connect-${p.id}`}
                  >
                    <div className="w-12 h-12 rounded-[var(--radius)] flex items-center justify-center shadow-sm overflow-hidden bg-card">
                      <p.icon className="w-7 h-7" />
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-sm font-heading text-foreground">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.desc}</div>
                    </div>
                    {p.id === "google" && googleConnecting && (
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    )}
                    {p.id === "google" && hasGoogleConnection && !googleConnecting && (
                      <span className="text-xs text-primary font-ui bg-primary/10 px-2 py-0.5 rounded-full">+ Add another account</span>
                    )}
                    {p.id === "microsoft" && microsoftConnecting && (
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    )}
                    {p.id === "microsoft" && hasMicrosoftConnection && !microsoftConnecting && (
                      <span className="text-xs text-primary font-ui bg-primary/10 px-2 py-0.5 rounded-full">+ Add another account</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex items-start gap-2 rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.3)] dark:border-[hsl(var(--brand-warning)/0.3)] bg-[hsl(var(--brand-warning)/0.08)] dark:bg-[hsl(var(--brand-warning)/0.1)] px-3 py-2.5" data-testid="info-yahoo-workaround">
                <AlertTriangle className="w-4 h-4 text-[hsl(var(--brand-warning))] dark:text-[hsl(var(--brand-warning))] shrink-0 mt-0.5" />
                <p className="text-xs text-[hsl(var(--brand-warning))] dark:text-[hsl(var(--brand-warning))]">
                  <span className="font-ui">Using Yahoo Calendar?</span> Subscribe to it within a free Google Calendar account, then connect that Google account here.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConnectDialogOpen(false)}>Cancel</Button>
              </DialogFooter>
            </>
          )}

          {connectStep === "google-calendars" && (
            <>
              <p className="text-sm text-muted-foreground">
                {connectingGoogleEmail && (
                  <span className="font-ui text-foreground">{connectingGoogleEmail} — </span>
                )}
                Select which calendars to connect. Events from selected calendars will block your booking availability.
              </p>
              <div className="space-y-2 py-2">
                {!googleCalendars ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : googleCalendars.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No calendars found.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between pb-1">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => {
                          if (selectedCalendarIds.length === googleCalendars.length) {
                            setSelectedCalendarIds([]);
                            setConflictCalendarIds([]);
                          } else {
                            const allIds = googleCalendars.map((c: any) => c.id);
                            setSelectedCalendarIds(allIds);
                            setConflictCalendarIds(allIds);
                          }
                        }}
                        data-testid="button-toggle-all-calendars"
                      >
                        {selectedCalendarIds.length === googleCalendars.length ? "Deselect All" : "Select All"}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {selectedCalendarIds.length} of {googleCalendars.length} selected
                      </span>
                    </div>
                    {googleCalendars.map((cal: any) => {
                      const isSelected = selectedCalendarIds.includes(cal.id);
                      const isConflict = conflictCalendarIds.includes(cal.id);
                      return (
                        <div
                          key={cal.id}
                          className={`rounded-[var(--radius)] border transition-colors ${
                            isSelected ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-secondary/30"
                          }`}
                        >
                          <button
                            onClick={() => {
                              if (isSelected) {
                                setSelectedCalendarIds((prev) => prev.filter((id) => id !== cal.id));
                                setConflictCalendarIds((prev) => prev.filter((id) => id !== cal.id));
                              } else {
                                setSelectedCalendarIds((prev) => [...prev, cal.id]);
                                setConflictCalendarIds((prev) => [...prev, cal.id]);
                              }
                            }}
                            className="w-full flex items-center gap-3 p-3 cursor-pointer text-left"
                            data-testid={`button-gcal-${cal.id}`}
                          >
                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                              isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                            }`}>
                              {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                            </div>
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cal.backgroundColor || "#4285f4" }} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-ui truncate block">{cal.summary}</span>
                              <span className="text-xs text-muted-foreground truncate block">{cal.id}</span>
                            </div>
                            {cal.primary && (
                              <span className="text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">Primary</span>
                            )}
                          </button>
                          {isSelected && (
                            <div className="flex items-center gap-2 px-3 pb-3 pt-0 ml-8">
                              <Switch
                                checked={isConflict}
                                onCheckedChange={(v) => {
                                  setConflictCalendarIds((prev) =>
                                    v ? [...prev, cal.id] : prev.filter((id) => id !== cal.id)
                                  );
                                }}
                                data-testid={`switch-conflict-select-${cal.id}`}
                              />
                              <span className="text-xs text-muted-foreground">Check conflicts</span>
                              <span className="text-[10px] text-muted-foreground/60">— blocks booking slots</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { setConnectStep("pick"); setConnectProvider(null); setSelectedCalendarIds([]); setConflictCalendarIds([]); setConnectingGoogleEmail(null); }}>Back</Button>
                <Button
                  disabled={selectedCalendarIds.length === 0 || addConnectionMutation.isPending}
                  onClick={() => addConnectionMutation.mutate({ provider: "google", calendarIds: selectedCalendarIds, googleEmail: connectingGoogleEmail || undefined, conflictCalendarIds })}
                  data-testid="button-connect-selected"
                >
                  {addConnectionMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : null}
                  Connect {selectedCalendarIds.length > 0 ? `${selectedCalendarIds.length} Calendar${selectedCalendarIds.length > 1 ? "s" : ""}` : "Selected"}
                </Button>
              </DialogFooter>
            </>
          )}

          {connectStep === "microsoft-calendars" && (
            <>
              <p className="text-sm text-muted-foreground">
                {connectingMicrosoftEmail && (
                  <span className="font-ui text-foreground">{connectingMicrosoftEmail} — </span>
                )}
                Select which calendars to connect. Events from selected calendars will block your booking availability.
              </p>
              <div className="space-y-2 py-2">
                {!microsoftCalendars ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : microsoftCalendars.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No calendars found.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between pb-1">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => {
                          if (selectedCalendarIds.length === microsoftCalendars.length) {
                            setSelectedCalendarIds([]);
                            setConflictCalendarIds([]);
                          } else {
                            const allIds = microsoftCalendars.map((c: any) => c.id);
                            setSelectedCalendarIds(allIds);
                            setConflictCalendarIds(allIds);
                          }
                        }}
                        data-testid="button-toggle-all-ms-calendars"
                      >
                        {selectedCalendarIds.length === microsoftCalendars.length ? "Deselect All" : "Select All"}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {selectedCalendarIds.length} of {microsoftCalendars.length} selected
                      </span>
                    </div>
                    {microsoftCalendars.map((cal: any) => {
                      const isSelected = selectedCalendarIds.includes(cal.id);
                      const isConflict = conflictCalendarIds.includes(cal.id);
                      return (
                        <div
                          key={cal.id}
                          className={`rounded-[var(--radius)] border transition-colors ${
                            isSelected ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-secondary/30"
                          }`}
                        >
                          <button
                            onClick={() => {
                              if (isSelected) {
                                setSelectedCalendarIds((prev) => prev.filter((id) => id !== cal.id));
                                setConflictCalendarIds((prev) => prev.filter((id) => id !== cal.id));
                              } else {
                                setSelectedCalendarIds((prev) => [...prev, cal.id]);
                                setConflictCalendarIds((prev) => [...prev, cal.id]);
                              }
                            }}
                            className="w-full flex items-center gap-3 p-3 cursor-pointer text-left"
                            data-testid={`button-mscal-${cal.id}`}
                          >
                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                              isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                            }`}>
                              {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                            </div>
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cal.backgroundColor || "#0078d4" }} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-ui truncate block">{cal.summary}</span>
                            </div>
                            {cal.primary && (
                              <span className="text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">Default</span>
                            )}
                          </button>
                          {isSelected && (
                            <div className="flex items-center gap-2 px-3 pb-3 pt-0 ml-8">
                              <Switch
                                checked={isConflict}
                                onCheckedChange={(v) => {
                                  setConflictCalendarIds((prev) =>
                                    v ? [...prev, cal.id] : prev.filter((id) => id !== cal.id)
                                  );
                                }}
                                data-testid={`switch-conflict-select-ms-${cal.id}`}
                              />
                              <span className="text-xs text-muted-foreground">Check conflicts</span>
                              <span className="text-[10px] text-muted-foreground/60">— blocks booking slots</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { setConnectStep("pick"); setConnectProvider(null); setSelectedCalendarIds([]); setConflictCalendarIds([]); setConnectingMicrosoftEmail(null); }}>Back</Button>
                <Button
                  disabled={selectedCalendarIds.length === 0 || addConnectionMutation.isPending}
                  onClick={() => addConnectionMutation.mutate({ provider: "microsoft", calendarIds: selectedCalendarIds, microsoftEmail: connectingMicrosoftEmail || undefined, conflictCalendarIds })}
                  data-testid="button-connect-ms-selected"
                >
                  {addConnectionMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : null}
                  Connect {selectedCalendarIds.length > 0 ? `${selectedCalendarIds.length} Calendar${selectedCalendarIds.length > 1 ? "s" : ""}` : "Selected"}
                </Button>
              </DialogFooter>
            </>
          )}

          {connectStep === "email" && (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {(() => { const P = CALENDAR_PROVIDERS.find((p) => p.id === connectProvider); return P ? <P.icon className="w-5 h-5" style={{ color: P.color }} /> : null; })()}
                <span className="font-ui">{(() => { const P = CALENDAR_PROVIDERS.find((p) => p.id === connectProvider); return P ? `${P.name} — ${P.desc}` : ""; })()}</span>
              </div>
              <div className="space-y-2 py-2">
                <Label>Email address for this calendar</Label>
                <Input
                  type="email"
                  value={connectEmail}
                  onChange={(e) => setConnectEmail(e.target.value)}
                  placeholder="you@example.com"
                  data-testid="input-connect-email"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setConnectStep("pick"); setConnectProvider(null); }}>Back</Button>
                <Button
                  onClick={() => addConnectionMutation.mutate({ provider: connectProvider!, email: connectEmail })}
                  disabled={addConnectionMutation.isPending || !connectEmail}
                  data-testid="button-connect-confirm"
                >
                  {addConnectionMutation.isPending ? "Connecting..." : "Connect"}
                </Button>
              </DialogFooter>
            </>
          )}

          {connectStep === "apple-connect" && (
            <>
              <p className="text-sm text-muted-foreground">
                Because Apple prioritizes security, you will need to generate a one-time &ldquo;App-Specific Password&rdquo; to connect your calendar. It only takes a minute!
              </p>
              <div className="space-y-3 py-2">
                <div className="bg-secondary/30 rounded-[var(--radius)] p-4 space-y-2">
                  <ol className="text-sm text-foreground space-y-2 list-decimal list-inside">
                    <li>Go to <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-ui">appleid.apple.com</a> and sign in.</li>
                    <li>Select <span className="font-ui">Sign-In and Security</span>.</li>
                    <li>Select <span className="font-ui">App-Specific Passwords</span>.</li>
                    <li>Click <span className="font-ui">Generate an app-specific password</span>.</li>
                    <li>Name the password <span className="font-ui">&ldquo;GoStork&rdquo;</span> and click <span className="font-ui">Create</span>.</li>
                    <li>Enter your Apple ID email below and paste the password.</li>
                  </ol>
                </div>
                <div className="space-y-2">
                  <Label>Apple ID Email</Label>
                  <Input
                    type="email"
                    value={connectEmail}
                    onChange={(e) => setConnectEmail(e.target.value)}
                    placeholder="you@icloud.com"
                    data-testid="input-apple-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label>App-Specific Password</Label>
                  <Input
                    type="password"
                    value={connectAppPassword}
                    onChange={(e) => setConnectAppPassword(e.target.value)}
                    placeholder="xxxx-xxxx-xxxx-xxxx"
                    data-testid="input-apple-password"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setConnectStep("pick"); setConnectProvider(null); setConnectEmail(""); setConnectAppPassword(""); }} data-testid="button-apple-back">Back</Button>
                <Button
                  disabled={caldavConnecting || !connectEmail || !connectAppPassword}
                  onClick={async () => {
                    setCaldavConnecting(true);
                    try {
                      const res = await apiRequest("POST", "/api/calendar/caldav/connect", { provider: "apple", email: connectEmail, appPassword: connectAppPassword });
                      const data = await res.json();
                      setCaldavCalendars(data.calendars || []);
                      setCaldavConnectingEmail(data.email);
                      setConnectProvider("apple");
                      setSelectedCalendarIds([]);
                      setConflictCalendarIds([]);
                      setConnectStep("caldav-calendars");
                      toast({ title: `Apple account (${data.email}) connected! Select calendars to sync.`, variant: "success" });
                    } catch (e: any) {
                      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
                    } finally {
                      setCaldavConnecting(false);
                    }
                  }}
                  data-testid="button-apple-connect"
                >
                  {caldavConnecting ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Connecting...</> : "Connect"}
                </Button>
              </DialogFooter>
            </>
          )}

          {connectStep === "caldav-calendars" && (
            <>
              <p className="text-sm text-muted-foreground">
                {caldavConnectingEmail && (
                  <span className="font-ui text-foreground">{caldavConnectingEmail} — </span>
                )}
                Select which calendars to connect. Events from selected calendars will block your booking availability.
              </p>
              <div className="space-y-2 py-2">
                {caldavCalendars.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No calendars found.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between pb-1">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => {
                          if (selectedCalendarIds.length === caldavCalendars.length) {
                            setSelectedCalendarIds([]);
                            setConflictCalendarIds([]);
                          } else {
                            const allIds = caldavCalendars.map((c: any) => c.id);
                            setSelectedCalendarIds(allIds);
                            setConflictCalendarIds(allIds);
                          }
                        }}
                        data-testid="button-toggle-all-caldav-calendars"
                      >
                        {selectedCalendarIds.length === caldavCalendars.length ? "Deselect All" : "Select All"}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {selectedCalendarIds.length} of {caldavCalendars.length} selected
                      </span>
                    </div>
                    {caldavCalendars.map((cal: any) => {
                      const isSelected = selectedCalendarIds.includes(cal.id);
                      const isConflict = conflictCalendarIds.includes(cal.id);
                      return (
                        <div
                          key={cal.id}
                          className={`rounded-[var(--radius)] border transition-colors ${
                            isSelected ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-secondary/30"
                          }`}
                        >
                          <button
                            onClick={() => {
                              if (isSelected) {
                                setSelectedCalendarIds((prev) => prev.filter((id) => id !== cal.id));
                                setConflictCalendarIds((prev) => prev.filter((id) => id !== cal.id));
                              } else {
                                setSelectedCalendarIds((prev) => [...prev, cal.id]);
                                setConflictCalendarIds((prev) => [...prev, cal.id]);
                              }
                            }}
                            className="w-full flex items-center gap-3 p-3 cursor-pointer text-left"
                            data-testid={`button-caldav-cal-${cal.name}`}
                          >
                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                              isSelected ? "bg-primary border-primary" : "border-muted-foreground/30"
                            }`}>
                              {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                            </div>
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cal.color || "#6b7280" }} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-ui truncate block">{cal.name}</span>
                            </div>
                          </button>
                          {isSelected && (
                            <div className="flex items-center gap-2 px-3 pb-3 pt-0 ml-8">
                              <Switch
                                checked={isConflict}
                                onCheckedChange={(v) => {
                                  setConflictCalendarIds((prev) =>
                                    v ? [...prev, cal.id] : prev.filter((id) => id !== cal.id)
                                  );
                                }}
                                data-testid={`switch-caldav-conflict-${cal.name}`}
                              />
                              <span className="text-xs text-muted-foreground">Check conflicts</span>
                              <span className="text-[10px] text-muted-foreground/60">— blocks booking slots</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => {
                  setConnectStep("apple-connect");
                  setSelectedCalendarIds([]);
                  setConflictCalendarIds([]);
                }} data-testid="button-caldav-cal-back">Back</Button>
                <Button
                  disabled={selectedCalendarIds.length === 0 || caldavSelectMutation.isPending}
                  onClick={() => caldavSelectMutation.mutate({
                    provider: connectProvider!,
                    email: caldavConnectingEmail!,
                    calendarIds: selectedCalendarIds,
                    conflictCalendarIds,
                  })}
                  data-testid="button-caldav-connect-selected"
                >
                  {caldavSelectMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : null}
                  Connect {selectedCalendarIds.length > 0 ? `${selectedCalendarIds.length} Calendar${selectedCalendarIds.length > 1 ? "s" : ""}` : "Selected"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Date Override</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={overrideDate}
                onChange={(e) => setOverrideDate(e.target.value)}
                min={new Date().toISOString().split("T")[0]}
                data-testid="input-override-date"
              />
            </div>

            <div className="space-y-2">
              <Label>Label (optional)</Label>
              <Input
                value={overrideLabel}
                onChange={(e) => setOverrideLabel(e.target.value)}
                placeholder="e.g., Holiday, Conference, Special hours"
                data-testid="input-override-label"
              />
            </div>

            <div className="flex items-center gap-3 p-3 rounded-[var(--radius)] border border-border/30">
              <div className="flex items-center gap-3 flex-1">
                <button
                  type="button"
                  onClick={() => setOverrideIsAvailable(true)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-sm font-ui transition-colors ${
                    overrideIsAvailable
                      ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] border border-[hsl(var(--brand-success)/0.3)]"
                      : "text-muted-foreground hover:bg-secondary/30"
                  }`}
                  data-testid="button-override-available"
                >
                  <CalendarCheck className="w-4 h-4" /> Available
                </button>
                <button
                  type="button"
                  onClick={() => setOverrideIsAvailable(false)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-sm font-ui transition-colors ${
                    !overrideIsAvailable
                      ? "bg-destructive/15 text-destructive border border-destructive/30"
                      : "text-muted-foreground hover:bg-secondary/30"
                  }`}
                  data-testid="button-override-unavailable"
                >
                  <Ban className="w-4 h-4" /> Unavailable
                </button>
              </div>
            </div>

            {overrideIsAvailable && (
              <div className="space-y-2">
                <Label>Custom hours for this date</Label>
                {overrideSlots.map((slot, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={slot.startTime}
                      onChange={(e) => {
                        const updated = [...overrideSlots];
                        updated[i] = { ...updated[i], startTime: e.target.value };
                        setOverrideSlots(updated);
                      }}
                      className="w-28 text-sm"
                      data-testid={`input-override-start-${i}`}
                    />
                    <span className="text-muted-foreground text-sm">to</span>
                    <Input
                      type="time"
                      value={slot.endTime}
                      onChange={(e) => {
                        const updated = [...overrideSlots];
                        updated[i] = { ...updated[i], endTime: e.target.value };
                        setOverrideSlots(updated);
                      }}
                      className="w-28 text-sm"
                      data-testid={`input-override-end-${i}`}
                    />
                    {overrideSlots.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOverrideSlots(overrideSlots.filter((_, j) => j !== i))}
                        className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOverrideSlots([...overrideSlots, { startTime: "09:00", endTime: "17:00" }])}
                  className="text-xs text-primary h-7 px-2"
                >
                  <Plus className="w-3 h-3 mr-1" /> Add time block
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!overrideDate) {
                  toast({ title: "Please select a date", variant: "destructive" });
                  return;
                }
                upsertOverrideMutation.mutate({
                  date: overrideDate,
                  isAvailable: overrideIsAvailable,
                  slots: overrideIsAvailable ? overrideSlots : null,
                  label: overrideLabel || null,
                });
              }}
              disabled={upsertOverrideMutation.isPending}
              data-testid="button-save-override"
            >
              {upsertOverrideMutation.isPending ? "Saving..." : "Save Override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConnId} onOpenChange={(open) => { if (!open) setDeleteConnId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Calendar</DialogTitle>
            <DialogDescription>
              Are you sure you want to disconnect this calendar? Events from this calendar will no longer sync with your bookings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConnId(null)} data-testid="button-cancel-disconnect">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteConnId) {
                  deleteConnectionMutation.mutate(deleteConnId, {
                    onSettled: () => setDeleteConnId(null),
                  });
                }
              }}
              disabled={deleteConnectionMutation.isPending}
              data-testid="button-confirm-disconnect"
            >
              {deleteConnectionMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
