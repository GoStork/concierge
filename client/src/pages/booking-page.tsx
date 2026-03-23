import { useState, useMemo, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Loader2, Calendar, Clock, Globe, Video, User, Users, ChevronLeft, ChevronRight, Check, ChevronsUpDown, X, UserPlus, Plus,
} from "lucide-react";
import { AddToCalendarButtons } from "@/components/calendar/add-to-calendar-buttons";
import { useCompanyName } from "@/hooks/use-brand-settings";

function getUtcOffset(tz: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = formatter.formatToParts(new Date());
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    return offsetPart?.value?.replace("GMT", "UTC") || "";
  } catch {
    return "";
  }
}

function formatTzLabel(tz: string): string {
  const offset = getUtcOffset(tz);
  return `(${offset}) ${tz.replace(/_/g, " ")}`;
}
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isBefore, isToday, isSameDay, isSameMonth, startOfDay } from "date-fns";

function generateCalendarDays(month: Date) {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const days = eachDayOfInterval({ start, end });

  const startDayOfWeek = getDay(start);
  const paddingBefore = Array.from({ length: startDayOfWeek }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() - (startDayOfWeek - i));
    return { date: d, isCurrentMonth: false };
  });

  const endDayOfWeek = getDay(end);
  const paddingAfter = Array.from({ length: 6 - endDayOfWeek }, (_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() + (i + 1));
    return { date: d, isCurrentMonth: false };
  });

  return [
    ...paddingBefore,
    ...days.map((d) => ({ date: d, isCurrentMonth: true })),
    ...paddingAfter,
  ];
}

function formatTime12(time24: string): string {
  const [h, m] = time24.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const companyName = useCompanyName();
  const brandQuery = useBrandSettings();
  const brand = brandQuery.data;
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [bookerTimezone, setBookerTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [tzSearchOpen, setTzSearchOpen] = useState(false);
  const [step, setStep] = useState<"date" | "form" | "confirmed">("date");
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [phone, setPhone] = useState((user as any)?.mobileNumber || "");
  const [notes, setNotes] = useState("");
  const [additionalAttendees, setAdditionalAttendees] = useState<{ email: string; name: string; phone: string }[]>([]);
  const [showAttendeeFields, setShowAttendeeFields] = useState(false);
  const [newAttendeeEmail, setNewAttendeeEmail] = useState("");
  const [newAttendeeName, setNewAttendeeName] = useState("");
  const [newAttendeePhone, setNewAttendeePhone] = useState("");
  const [booking, setBooking] = useState<any>(null);

  const navigate = useNavigate();
  const parentUserId = user ? (user as any).id : null;
  const userRoles: string[] = user ? ((user as any).roles || []) : [];
  const isParentUser = userRoles.includes("PARENT") && userRoles.length === 1;
  const isViewer = (user as any)?.parentAccountRole === "VIEWER";

  useEffect(() => {
    if (isViewer) navigate("/marketplace", { replace: true });
  }, [isViewer, navigate]);

  const { data: parentConnections } = useQuery<any[]>({
    queryKey: ["/api/calendar/connections", "parent-booking"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/connections", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isParentUser && !!parentUserId,
  });

  const parentHasConflictCalendar = isParentUser && parentConnections?.some((c: any) => c.isConflictCalendar && c.connected);
  const effectiveParentUserId = parentHasConflictCalendar ? parentUserId : null;

  const dateStr = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null;
  const monthStr = format(currentMonth, "yyyy-MM");

  const { data: availabilityDays } = useQuery<{ availableDays: number[] }>({
    queryKey: ["/api/calendar/availability-days", slug, monthStr, bookerTimezone, effectiveParentUserId],
    queryFn: async () => {
      let url = `/api/calendar/availability-days/${slug}?month=${monthStr}&timezone=${bookerTimezone}`;
      if (effectiveParentUserId) {
        url += `&parentUserId=${encodeURIComponent(effectiveParentUserId)}`;
      }
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { availableDays: [] };
      return res.json();
    },
    enabled: !!slug,
  });

  const availableDaySet = useMemo(() => new Set(availabilityDays?.availableDays || []), [availabilityDays]);

  const { data: pageInfo, isLoading: pageLoading } = useQuery({
    queryKey: ["/api/calendar/page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/page/${slug}`);
      if (!res.ok) throw new Error("Booking page not found");
      return res.json();
    },
  });

  const { data: availability, isLoading: slotsLoading } = useQuery({
    queryKey: ["/api/calendar/availability", slug, dateStr, bookerTimezone, effectiveParentUserId],
    queryFn: async () => {
      if (!dateStr) return null;
      let url = `/api/calendar/availability/${slug}?date=${dateStr}&timezone=${bookerTimezone}`;
      if (effectiveParentUserId) {
        url += `&parentUserId=${encodeURIComponent(effectiveParentUserId)}`;
      }
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load availability");
      return res.json();
    },
    enabled: !!dateStr,
  });

  const addAttendee = () => {
    const trimmed = newAttendeeEmail.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    if (trimmed === email.toLowerCase()) return;
    if (additionalAttendees.some(a => a.email === trimmed)) return;
    setAdditionalAttendees([...additionalAttendees, { email: trimmed, name: newAttendeeName.trim(), phone: newAttendeePhone.trim() }]);
    setNewAttendeeEmail("");
    setNewAttendeeName("");
    setNewAttendeePhone("");
  };

  const removeAttendee = (emailToRemove: string) => {
    setAdditionalAttendees(additionalAttendees.filter(a => a.email !== emailToRemove));
  };

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDate || !selectedSlot) throw new Error("Select a time");
      const scheduledAt = `${format(selectedDate, "yyyy-MM-dd")}T${selectedSlot}:00`;
      const finalAttendees = [...additionalAttendees];
      const pendingEmail = newAttendeeEmail.trim().toLowerCase();
      if (pendingEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pendingEmail) && pendingEmail !== email.toLowerCase() && !finalAttendees.some(a => a.email === pendingEmail)) {
        finalAttendees.push({ email: pendingEmail, name: newAttendeeName.trim(), phone: newAttendeePhone.trim() });
      }
      const res = await apiRequest("POST", `/api/calendar/book/${slug}`, {
        scheduledAt,
        name,
        email,
        phone: phone || null,
        notes: notes || null,
        timezone: bookerTimezone,
        additionalAttendees: finalAttendees.length > 0 ? finalAttendees.map(a => a.email) : undefined,
        attendeeDetails: finalAttendees.length > 0
          ? Object.fromEntries(finalAttendees.filter(a => a.name || a.phone).map(a => [a.email, { name: a.name || undefined, phone: a.phone || undefined }]))
          : undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.publicToken) {
        navigate(`/booking/${data.publicToken}`, { replace: true });
      } else {
        setBooking(data);
        setStep("confirmed");
      }
    },
  });

  const calendarDays = useMemo(() => generateCalendarDays(currentMonth), [currentMonth]);
  const today = startOfDay(new Date());

  const userInfo = pageInfo?.user;
  const providerInfo = userInfo?.provider;
  const siteLogo = pageInfo?.siteSettings?.logoWithNameUrl || pageInfo?.siteSettings?.logoUrl;
  const providerBrandLogo = providerInfo?.brandSettings?.logoWithNameUrl || providerInfo?.brandSettings?.logoUrl;
  const rawLogoUrl = siteLogo || providerBrandLogo || providerInfo?.logoUrl;
  const resolvedLogoUrl = getPhotoSrc(rawLogoUrl);
  const userPhotoSrc = getPhotoSrc(userInfo?.photoUrl);

  const fontHeading = brand?.headingFont || "DM Sans";
  const fontBody = brand?.bodyFont || "DM Sans";

  if (pageLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background/95 to-primary/5 flex items-center justify-center p-4">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (step === "confirmed" && booking) {
    const start = new Date(booking.scheduledAt);
    const isPending = booking.status === "PENDING";
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background/95 to-primary/5 flex items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-md">
          <div className="bg-card/60 backdrop-blur-2xl border border-white/20 rounded-3xl shadow-2xl p-8 md:p-10 text-center">
            <div className={`w-16 h-16 mx-auto mb-5 rounded-full flex items-center justify-center ${isPending ? "bg-[hsl(var(--brand-warning)/0.12)]" : "bg-primary/10"}`}>
              {isPending
                ? <Clock className="w-8 h-8 text-[hsl(var(--brand-warning))]" />
                : <Check className="w-8 h-8 text-primary" />
              }
            </div>
            <h1
              className="text-2xl font-bold tracking-tight mb-1"
              style={{ fontFamily: fontHeading }}
              data-testid="text-booking-confirmed"
            >
              {isPending ? "Request Submitted" : "Booking Confirmed"}
            </h1>
            <p className="text-muted-foreground text-sm mb-8" style={{ fontFamily: fontBody }}>
              {isPending
                ? `Your request has been sent — you'll be notified when ${booking.providerUser?.name || "the provider"} confirms.`
                : "You're all set. Details are below."}
            </p>

            <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-5 space-y-3.5 text-left mb-6">
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Calendar className="w-4 h-4 text-primary" />
                </div>
                <span className="font-medium" style={{ fontFamily: fontBody }}>{format(start, "EEEE, MMMM d, yyyy")}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Clock className="w-4 h-4 text-primary" />
                </div>
                <span style={{ fontFamily: fontBody }}>{format(start, "h:mm a")} ({booking.duration} min)</span>
              </div>
              {booking.meetingUrl && (
                <div className="flex items-center gap-3 text-sm">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Video className="w-4 h-4 text-primary" />
                  </div>
                  <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate" style={{ fontFamily: fontBody }}>{booking.meetingUrl}</a>
                </div>
              )}
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="w-4 h-4 text-primary" />
                </div>
                <span style={{ fontFamily: fontBody }}>with {booking.providerUser?.name || "Provider"}</span>
              </div>
            </div>

            {(() => {
              const details: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
              const emails: string[] = booking.attendeeEmails || [];
              const bookerEmail = emails[0];
              const seenEmails = new Set<string>();
              const participants: { label: string; sub?: string }[] = [];
              if (booking.attendeeName || bookerEmail) {
                participants.push({ label: booking.attendeeName || bookerEmail, sub: bookerEmail && booking.attendeeName ? bookerEmail : undefined });
                if (bookerEmail) seenEmails.add(bookerEmail.toLowerCase());
              }
              if (booking.parentUser && booking.parentUser.email?.toLowerCase() !== bookerEmail?.toLowerCase()) {
                participants.push({ label: booking.parentUser.name || booking.parentUser.email, sub: booking.parentUser.email });
                seenEmails.add(booking.parentUser.email.toLowerCase());
              }
              const pam = booking.parentAccountMembers || [];
              for (const m of pam) {
                if (seenEmails.has(m.email.toLowerCase())) continue;
                seenEmails.add(m.email.toLowerCase());
                participants.push({ label: m.name || m.email, sub: m.name ? m.email : undefined });
              }
              for (let i = 1; i < emails.length; i++) {
                const em = emails[i];
                if (seenEmails.has(em.toLowerCase())) continue;
                seenEmails.add(em.toLowerCase());
                const d = details[em.toLowerCase()] || {};
                participants.push({ label: d.name || em, sub: d.name ? em : undefined });
              }
              if (participants.length === 0) return null;
              return (
                <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-5 text-left mb-6" data-testid="section-participants">
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium" style={{ fontFamily: fontHeading }}>Participants</span>
                  </div>
                  <div className="space-y-2">
                    {participants.map((p, i) => (
                      <div key={i} className="flex items-center gap-2.5 text-sm pl-1">
                        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <User className="w-3.5 h-3.5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <span className="font-medium" style={{ fontFamily: fontBody }} data-testid={`text-participant-name-${i}`}>{p.label}</span>
                          {p.sub && <span className="text-muted-foreground ml-1 text-xs">({p.sub})</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {isPending && (
              <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-xl p-4 mb-5">
                <p className="text-sm text-[hsl(var(--brand-warning))] font-medium" style={{ fontFamily: fontBody }}>Awaiting provider confirmation</p>
                <p className="text-xs text-[hsl(var(--brand-warning))] mt-1" style={{ fontFamily: fontBody }}>We'll send you an email once your booking is confirmed.</p>
              </div>
            )}

            <div className="flex flex-col gap-3">
              {!isPending && (
                <>
                  <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1.5" data-testid="text-calendar-invite-note">
                    <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                    A calendar invitation has been sent to your email
                  </p>
                  <AddToCalendarButtons booking={booking} />
                </>
              )}
              <a href={`/booking/${booking.publicToken}`} className="mt-2 text-sm text-primary hover:underline font-medium" data-testid="link-manage-booking">
                {isPending ? "View booking details" : "Manage or reschedule this booking"}
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background/95 to-primary/5 flex items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-5xl">
        <div className="bg-card/60 backdrop-blur-2xl border border-white/20 rounded-3xl shadow-2xl overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-[380px_1fr]">

            <div className="bg-primary/[0.03] backdrop-blur-sm p-8 md:p-10 border-b md:border-b-0 md:border-r border-white/10">
              {resolvedLogoUrl && (
                <img
                  src={resolvedLogoUrl}
                  alt={providerInfo?.name || ""}
                  className="h-9 object-contain mb-8"
                  data-testid="img-provider-logo"
                />
              )}

              <div className="flex items-center gap-4 mb-8">
                {userPhotoSrc ? (
                  <div className="relative">
                    <div className="w-14 h-14 rounded-full ring-2 ring-white/30 ring-offset-2 ring-offset-transparent overflow-hidden">
                      <img src={userPhotoSrc} alt="" className="w-full h-full object-cover" data-testid="img-host-photo" />
                    </div>
                  </div>
                ) : (
                  <div className="w-14 h-14 rounded-full bg-primary/10 ring-2 ring-white/30 ring-offset-2 ring-offset-transparent flex items-center justify-center text-primary">
                    <User className="w-7 h-7" />
                  </div>
                )}
                <div>
                  <h2
                    className="text-xl font-bold tracking-tight"
                    style={{ fontFamily: fontHeading }}
                    data-testid="text-host-name"
                  >
                    {userInfo?.name || "Team Member"}
                  </h2>
                  {providerInfo && (
                    <p className="text-sm text-muted-foreground mt-0.5" style={{ fontFamily: fontBody }}>
                      {providerInfo.name}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-primary/8 flex items-center justify-center shrink-0">
                    <Clock className="w-4.5 h-4.5 text-secondary-foreground/60" />
                  </div>
                  <span className="text-sm text-muted-foreground" style={{ fontFamily: fontBody }}>
                    {pageInfo?.meetingDuration || 30} minutes
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-primary/8 flex items-center justify-center shrink-0">
                    <Video className="w-4.5 h-4.5 text-secondary-foreground/60" />
                  </div>
                  <span className="text-sm text-muted-foreground" style={{ fontFamily: fontBody }}>Video call</span>
                </div>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-primary/8 flex items-center justify-center shrink-0">
                    <Globe className="w-4.5 h-4.5 text-secondary-foreground/60" />
                  </div>
                  <Popover open={tzSearchOpen} onOpenChange={setTzSearchOpen}>
                    <PopoverTrigger asChild>
                      <button
                        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors min-w-0"
                        data-testid="select-booker-timezone"
                      >
                        <span style={{ fontFamily: fontBody }}>{formatTzLabel(bookerTimezone)}</span>
                        <ChevronsUpDown className="h-3 w-3 opacity-50 shrink-0" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[380px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search by city or region..." data-testid="input-booker-timezone-search" />
                        <CommandList>
                          <CommandEmpty>No timezone found.</CommandEmpty>
                          <CommandGroup className="max-h-[300px] overflow-auto">
                            {Intl.supportedValuesOf("timeZone").map((tz) => (
                              <CommandItem
                                key={tz}
                                value={`${tz} ${tz.replace(/_/g, " ")} ${getUtcOffset(tz)}`}
                                onSelect={() => {
                                  setBookerTimezone(tz);
                                  setTzSearchOpen(false);
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${bookerTimezone === tz ? "opacity-100" : "opacity-0"}`} />
                                {formatTzLabel(tz)}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </div>

            <div className="p-8 md:p-10">
              {step === "date" && (
                <div className="space-y-6">
                  <h3
                    className="text-2xl font-bold tracking-tight"
                    style={{ fontFamily: fontHeading }}
                    data-testid="text-select-date"
                  >
                    Select a Date & Time
                  </h3>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-xl hover:bg-white/10"
                        onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                        data-testid="button-prev-month"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <span
                        className="text-sm font-semibold tracking-wide"
                        style={{ fontFamily: fontHeading }}
                      >
                        {format(currentMonth, "MMMM yyyy")}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-xl hover:bg-white/10"
                        onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                        data-testid="button-next-month"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center">
                      {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                        <div
                          key={d}
                          className="text-xs font-medium text-muted-foreground/60 py-2 uppercase tracking-wider"
                          style={{ fontFamily: fontBody }}
                        >
                          {d}
                        </div>
                      ))}
                      {calendarDays.map((day, i) => {
                        const isPast = isBefore(day.date, today) && !isToday(day.date);
                        const isSelected = selectedDate && isSameDay(day.date, selectedDate);
                        const isCurrentMonthDay = day.isCurrentMonth && isSameMonth(day.date, currentMonth);
                        const noAvailability = isCurrentMonthDay && !isPast && !availableDaySet.has(day.date.getDate());
                        const isDisabled = isPast || !day.isCurrentMonth || noAvailability;
                        const isTodayDate = isToday(day.date);
                        return (
                          <button
                            key={i}
                            onClick={() => { if (!isDisabled) { setSelectedDate(day.date); setSelectedSlot(null); } }}
                            disabled={isDisabled}
                            className={`relative w-10 h-10 rounded-full text-sm transition-all duration-200 mx-auto flex items-center justify-center ${
                              !day.isCurrentMonth ? "text-muted-foreground/20" :
                              isPast ? "text-muted-foreground/30 cursor-not-allowed" :
                              noAvailability ? "text-muted-foreground/30 cursor-not-allowed" :
                              isSelected ? "bg-primary text-primary-foreground font-semibold shadow-lg shadow-primary/30" :
                              isTodayDate ? "text-primary font-semibold hover:bg-primary/10 cursor-pointer" :
                              "hover:bg-white/10 cursor-pointer text-foreground/80"
                            }`}
                            style={{ fontFamily: fontBody }}
                            data-testid={`day-${format(day.date, "yyyy-MM-dd")}`}
                          >
                            {day.date.getDate()}
                            {isTodayDate && !isSelected && (
                              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {selectedDate && (
                    <div className="space-y-3">
                      <h4
                        className="text-sm font-semibold text-foreground/80"
                        style={{ fontFamily: fontHeading }}
                      >
                        {format(selectedDate, "EEEE, MMMM d")}
                      </h4>
                      {availability?.parentCalendarActive && (
                        <div className="flex items-center gap-1.5 text-xs text-primary bg-primary/5 backdrop-blur-sm px-3 py-2 rounded-xl border border-primary/10" data-testid="text-parent-calendar-active">
                          <Calendar className="w-3.5 h-3.5" />
                          <span style={{ fontFamily: fontBody }}>Showing times that work for both of you</span>
                        </div>
                      )}
                      {slotsLoading ? (
                        <div className="flex justify-center py-8">
                          <Loader2 className="w-5 h-5 animate-spin text-primary" />
                        </div>
                      ) : availability?.slots?.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 py-8 px-4 bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10" data-testid="text-no-slots">
                          <Clock className="w-8 h-8 text-muted-foreground/40" />
                          <p className="text-sm font-medium" style={{ fontFamily: fontHeading }}>No available times</p>
                          <p className="text-xs text-muted-foreground text-center" style={{ fontFamily: fontBody }}>There are no open slots on this date. Please try another day.</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                          {availability?.slots?.map((slot: any) => {
                            const isSlotSelected = selectedSlot === slot.time;
                            return (
                              <button
                                key={slot.time}
                                onClick={() => { setSelectedSlot(slot.time); setStep("form"); }}
                                className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer ${
                                  isSlotSelected
                                    ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 scale-[1.02]"
                                    : "bg-white/5 border border-white/10 hover:bg-primary/15 hover:border-primary/40 text-foreground/80"
                                }`}
                                style={{ fontFamily: fontBody }}
                                data-testid={`slot-${slot.time}`}
                              >
                                {formatTime12(slot.time)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {step === "form" && selectedDate && selectedSlot && (
                <div className="space-y-6">
                  <button
                    onClick={() => setStep("date")}
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer group"
                    data-testid="button-back-to-dates"
                  >
                    <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
                    <span style={{ fontFamily: fontBody }}>Back</span>
                  </button>

                  <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-4 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <Calendar className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <span className="text-sm font-semibold" style={{ fontFamily: fontHeading }}>{format(selectedDate, "EEEE, MMMM d")}</span>
                      <span className="text-sm text-muted-foreground ml-2" style={{ fontFamily: fontBody }}>at {formatTime12(selectedSlot)}</span>
                    </div>
                  </div>

                  <form
                    onSubmit={(e) => { e.preventDefault(); bookMutation.mutate(); }}
                    className="space-y-4"
                  >
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium" style={{ fontFamily: fontBody }}>Name *</Label>
                      <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl h-11"
                        data-testid="input-book-name"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium" style={{ fontFamily: fontBody }}>Email *</Label>
                      <Input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl h-11"
                        data-testid="input-book-email"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium" style={{ fontFamily: fontBody }}>Phone</Label>
                      <Input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl h-11"
                        data-testid="input-book-phone"
                      />
                    </div>

                    <div className="space-y-2">
                      {additionalAttendees.length > 0 && !showAttendeeFields && (
                        <div className="space-y-2">
                          {additionalAttendees.map((ae) => (
                            <div
                              key={ae.email}
                              className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-xl px-3 py-2.5"
                              data-testid={`attendee-chip-${ae.email}`}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate" style={{ fontFamily: fontBody }}>{ae.name || ae.email}</p>
                                {ae.name && <p className="text-xs text-muted-foreground truncate">{ae.email}</p>}
                                {ae.phone && <p className="text-xs text-muted-foreground">{ae.phone}</p>}
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAttendee(ae.email)}
                                className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                                data-testid={`button-remove-attendee-${ae.email}`}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {!showAttendeeFields ? (
                        <button
                          type="button"
                          onClick={() => setShowAttendeeFields(true)}
                          className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
                          style={{ fontFamily: fontBody }}
                          data-testid="button-show-attendee-fields"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          Add Additional Attendees
                        </button>
                      ) : (
                        <div className="space-y-3 bg-white/5 border border-white/10 rounded-2xl p-4">
                          <Label className="flex items-center gap-1.5 text-sm font-medium" style={{ fontFamily: fontHeading }}>
                            <UserPlus className="w-3.5 h-3.5" />
                            Additional Attendees
                          </Label>
                          <p className="text-[11px] text-muted-foreground leading-tight" style={{ fontFamily: fontBody }}>
                            Invite others to this meeting. They'll receive all notifications.
                          </p>
                          {additionalAttendees.length > 0 && (
                            <div className="space-y-2">
                              {additionalAttendees.map((ae) => (
                                <div
                                  key={ae.email}
                                  className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-xl px-3 py-2.5"
                                  data-testid={`attendee-chip-${ae.email}`}
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate" style={{ fontFamily: fontBody }}>{ae.name || ae.email}</p>
                                    {ae.name && <p className="text-xs text-muted-foreground truncate">{ae.email}</p>}
                                    {ae.phone && <p className="text-xs text-muted-foreground">{ae.phone}</p>}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeAttendee(ae.email)}
                                    className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                                    data-testid={`button-remove-attendee-${ae.email}`}
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="space-y-2">
                            <Input
                              type="email"
                              value={newAttendeeEmail}
                              onChange={(e) => setNewAttendeeEmail(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); addAttendee(); }
                              }}
                              placeholder="Email address *"
                              className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl h-9 text-sm"
                              data-testid="input-additional-attendee"
                            />
                            <div className="flex gap-2">
                              <Input
                                type="text"
                                value={newAttendeeName}
                                onChange={(e) => setNewAttendeeName(e.target.value)}
                                placeholder="Full Name (optional)"
                                className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl flex-1 h-9 text-sm"
                                data-testid="input-additional-attendee-name"
                              />
                              <Input
                                type="tel"
                                value={newAttendeePhone}
                                onChange={(e) => setNewAttendeePhone(e.target.value)}
                                placeholder="Mobile (optional)"
                                className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl flex-1 h-9 text-sm"
                                data-testid="input-additional-attendee-phone"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={addAttendee}
                              className="h-9 w-full gap-1.5 text-xs rounded-xl border-white/10 hover:bg-white/10"
                              disabled={!newAttendeeEmail.trim()}
                              data-testid="button-add-attendee"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              Add Attendee
                            </Button>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAttendeeFields(false)}
                            className="h-7 w-full text-xs text-muted-foreground"
                            data-testid="button-close-attendee-fields"
                          >
                            Done
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium" style={{ fontFamily: fontBody }}>Notes</Label>
                      <Textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Anything you'd like to share beforehand..."
                        rows={3}
                        className="bg-white/5 border-white/10 focus:border-primary/50 rounded-xl resize-none"
                        data-testid="input-book-notes"
                      />
                    </div>

                    {bookMutation.isError && (
                      <p className="text-sm text-destructive" style={{ fontFamily: fontBody }}>{(bookMutation.error as Error).message}</p>
                    )}

                    <Button
                      type="submit"
                      className="w-full h-12 rounded-xl text-sm font-semibold shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-all duration-200"
                      disabled={bookMutation.isPending}
                      data-testid="button-confirm-booking"
                    >
                      {bookMutation.isPending ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Booking...
                        </span>
                      ) : "Confirm Booking"}
                    </Button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground/60 mt-6" style={{ fontFamily: fontBody }}>
          Powered by <span className="font-semibold text-primary/70">{companyName}</span>
        </p>
      </div>
    </div>
  );
}
