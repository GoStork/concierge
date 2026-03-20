import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { deriveChatPalette } from "@/lib/chat-palette";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SwipeDeckCard, type TabSection } from "@/components/marketplace/swipe-deck-card";
import {
  mapDatabaseDonorToSwipeProfile,
  mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile,
  getDonorTabs,
  getSurrogateTabs,
  buildTitle,
  buildStatusLabel,
  getPhotoList,
} from "@/components/marketplace/swipe-mappers";
import { Loader2, Send, ArrowLeft, Sparkles, Headphones, FileText, Download, Heart, Brain, Stethoscope, MessageCircle, Shield, CalendarCheck, CalendarDays, X, ExternalLink, ChevronLeft, ChevronRight, Clock, Video, Globe, Check, Paperclip, UserPlus, Plus, Maximize, Minimize } from "lucide-react";
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isBefore, isToday, isSameDay, isSameMonth, startOfDay } from "date-fns";
import { apiRequest } from "@/lib/queryClient";

interface MatchCard {
  name: string;
  type: string;
  location?: string;
  photo?: string;
  reasons: string[];
  providerId: string;
  ownerProviderId?: string;
}

interface ConsultationCardData {
  providerId: string;
  providerName: string;
  providerLogo?: string;
  bookingUrl?: string;
  iframeEnabled?: boolean;
  providerEmail?: string;
  memberBookingSlug?: string;
  memberName?: string;
  memberPhoto?: string;
}

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  quickReplies?: string[];
  multiSelect?: boolean;
  matchCards?: MatchCard[];
  prepDoc?: boolean;
  consultationCard?: ConsultationCardData;
  senderType?: string;
  senderName?: string;
  uiCardType?: string;
  uiCardData?: any;
  createdAt?: string;
}

function chatDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

const CURATION_LINES = [
  "Analyzing your family-building goals...",
  "Matching your criteria with 1,000+ providers...",
  "Finalizing your personalized results...",
];

const PREP_DOC_SECTIONS = [
  { icon: Heart, title: "Personal & Lifestyle", items: ["Family background & motivation", "Daily life & support system", "Work schedule"] },
  { icon: Brain, title: "Values & Boundaries", items: ["Relationship expectations", "Level of involvement during pregnancy"] },
  { icon: Stethoscope, title: "Medical & Pregnancy", items: ["Past pregnancy history", "Embryo transfer preferences", "Openness to twins"] },
  { icon: MessageCircle, title: "Ethical Topics", items: ["Views on termination if medically advised", "Personal/religious considerations"] },
  { icon: Shield, title: "Legal & Communication", items: ["Prior surrogacy experience", "Preferred communication style"] },
];

function CurationOverlay({ brandColor, onComplete }: { brandColor: string; onComplete: () => void }) {
  const [lineIndex, setLineIndex] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    if (lineIndex >= CURATION_LINES.length) {
      const t = setTimeout(onComplete, 400);
      return () => clearTimeout(t);
    }
    const line = CURATION_LINES[lineIndex];
    if (charIndex < line.length) {
      const t = setTimeout(() => {
        setDisplayText(line.substring(0, charIndex + 1));
        setCharIndex(charIndex + 1);
      }, 30);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => {
        setLineIndex(lineIndex + 1);
        setCharIndex(0);
        setDisplayText("");
      }, 800);
      return () => clearTimeout(t);
    }
  }, [lineIndex, charIndex, onComplete]);

  return createPortal(
    <div
      className="flex flex-col items-center justify-center"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        backgroundColor: "hsl(var(--background) / 0.95)",
        WebkitBackdropFilter: "blur(4px)",
        backdropFilter: "blur(4px)",
      }}
      data-testid="curation-overlay"
    >
      <div className="flex flex-col items-center text-center px-8 max-w-md">
        <div className="relative mb-8">
          <div
            className="w-16 h-16 rounded-full"
            style={{
              border: `3px solid ${brandColor}20`,
              borderTopColor: brandColor,
              animation: "spin 1s linear infinite",
              WebkitAnimation: "spin 1s linear infinite",
            }}
          />
          <Sparkles
            className="w-6 h-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ color: brandColor }}
          />
        </div>
        <div className="h-8 flex items-center">
          <p
            className="text-lg font-medium"
            style={{ fontFamily: "var(--font-display)", color: brandColor }}
            data-testid="curation-text"
          >
            {displayText}
            <span style={{ animation: "pulse 2s cubic-bezier(0.4,0,0.6,1) infinite", WebkitAnimation: "pulse 2s cubic-bezier(0.4,0,0.6,1) infinite" }}>|</span>
          </p>
        </div>
        <div className="flex gap-2 mt-6">
          {CURATION_LINES.map((_, i) => (
            <div
              key={i}
              className="h-1.5 rounded-full transition-all duration-500"
              style={{
                width: i === lineIndex ? "2rem" : "0.5rem",
                backgroundColor: i <= lineIndex ? brandColor : `${brandColor}30`,
              }}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

function PrepDocCard({ brandColor }: { brandColor: string }) {
  return (
    <Card
      className="overflow-hidden max-w-sm animate-[slideUp_0.4s_ease-out_forwards]"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid="prep-doc-card"
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <FileText className="w-4 h-4 text-white" />
          <span className="text-white text-xs font-semibold uppercase tracking-wider">Match Call Prep Guide</span>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Here are the key topics to discuss during your first surrogate match call:
        </p>
        <div className="space-y-2.5">
          {PREP_DOC_SECTIONS.map((section, i) => (
            <div key={i} className="flex gap-2.5">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ backgroundColor: `${brandColor}15` }}
              >
                <section.icon className="w-3.5 h-3.5" style={{ color: brandColor }} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: brandColor }}>{section.title}</p>
                <ul className="mt-0.5 space-y-0.5">
                  {section.items.map((item, j) => (
                    <li key={j} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <span className="mt-1 w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: `${brandColor}60` }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
        <div className="pt-2 border-t">
          <a
            href="/surrogacy-match-call-guide.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium transition-opacity hover:opacity-80"
            style={{ color: brandColor }}
            data-testid="btn-download-prep-doc"
          >
            <Download className="w-4 h-4" />
            Download Full Guide (PDF)
          </a>
        </div>
        <p className="text-xs text-muted-foreground italic">
          Tip: Start warm and personal — this is a relationship-building moment, not just a checklist.
        </p>
      </div>
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Card>
  );
}

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
  return [...paddingBefore, ...days.map((d) => ({ date: d, isCurrentMonth: true })), ...paddingAfter];
}

function formatTime12(time24: string): string {
  const [h, m] = time24.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function RescheduleCalendarPicker({
  slug,
  booking,
  brandColor,
  onRescheduled,
  onCancel,
}: {
  slug: string;
  booking: any;
  brandColor: string;
  onRescheduled: (newBooking: any) => void;
  onCancel: () => void;
}) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const bookerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = startOfDay(new Date());
  const calendarDays = generateCalendarDays(currentMonth);
  const monthStr = format(currentMonth, "yyyy-MM");
  const dateStr = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null;

  const { data: availabilityDays } = useQuery<{ availableDays: number[] }>({
    queryKey: ["/api/calendar/availability-days", slug, monthStr, bookerTimezone, "reschedule"],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/availability-days/${slug}?month=${monthStr}&timezone=${bookerTimezone}`, { credentials: "include" });
      if (!res.ok) return { availableDays: [] };
      return res.json();
    },
    enabled: !!slug,
  });
  const availableDaySet = new Set(availabilityDays?.availableDays || []);

  const { data: availability, isLoading: slotsLoading } = useQuery({
    queryKey: ["/api/calendar/availability", slug, dateStr, bookerTimezone, "reschedule"],
    queryFn: async () => {
      if (!dateStr) return null;
      const res = await fetch(`/api/calendar/availability/${slug}?date=${dateStr}&timezone=${bookerTimezone}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load availability");
      return res.json();
    },
    enabled: !!dateStr,
  });

  async function handleReschedule() {
    if (!selectedDate || !selectedSlot || !booking.publicToken) return;
    setSubmitting(true);
    try {
      const scheduledAt = `${format(selectedDate, "yyyy-MM-dd")}T${selectedSlot}:00`;
      const res = await fetch(`/api/calendar/booking/${booking.publicToken}/reschedule-public`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ scheduledAt, bookerTimezone }),
      });
      if (res.ok) {
        const newBooking = await res.json();
        onRescheduled(newBooking);
      }
    } catch {} finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-7 text-center text-[10px] text-muted-foreground font-medium">
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {calendarDays.map((day, i) => {
          const d = day.date;
          const dayNum = d.getDate();
          const isPast = d < today;
          const inMonth = day.isCurrentMonth;
          const isAvailable = inMonth && availableDaySet.has(dayNum) && !isPast;
          const isSelected = selectedDate && isSameDay(d, selectedDate);
          const isTodayDate = isSameDay(d, today);
          return (
            <button
              key={i}
              onClick={() => { if (isAvailable) { setSelectedDate(d); setSelectedSlot(null); } }}
              disabled={!isAvailable}
              className={`aspect-square flex items-center justify-center text-xs rounded-full transition-colors cursor-pointer
                ${!inMonth ? "text-muted-foreground/20" : ""}
                ${isSelected ? "text-white font-bold" : ""}
                ${isAvailable && !isSelected ? "hover:bg-muted font-medium" : ""}
                ${inMonth && !isAvailable ? "text-muted-foreground/30 cursor-not-allowed" : ""}
                ${isTodayDate && !isSelected ? "ring-1 ring-primary" : ""}`}
              style={isSelected ? { backgroundColor: brandColor } : undefined}
              data-testid={`reschedule-day-${dayNum}`}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between items-center">
        <button onClick={() => setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} className="p-1 hover:bg-muted rounded cursor-pointer" data-testid="reschedule-prev-month">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs font-medium">{format(currentMonth, "MMMM yyyy")}</span>
        <button onClick={() => setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} className="p-1 hover:bg-muted rounded cursor-pointer" data-testid="reschedule-next-month">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      {selectedDate && (
        <div className="space-y-2">
          <p className="text-xs font-medium">{format(selectedDate, "EEE, MMM d")} — Select a time:</p>
          {slotsLoading ? (
            <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin" /></div>
          ) : availability?.slots?.length > 0 ? (
            <div className="grid grid-cols-3 gap-1.5">
              {availability.slots.map((s: any) => {
                const t = s.time || s;
                const isSel = selectedSlot === t;
                return (
                  <button
                    key={t}
                    onClick={() => setSelectedSlot(t)}
                    className={`text-xs py-1.5 rounded-md border transition-colors cursor-pointer ${isSel ? "text-white border-transparent font-semibold" : "border-border hover:bg-muted"}`}
                    style={isSel ? { backgroundColor: brandColor } : undefined}
                    data-testid={`reschedule-slot-${t}`}
                  >
                    {formatTime12(t)}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">No available slots</p>
          )}
        </div>
      )}
      {selectedSlot && (
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-lg border border-border hover:bg-muted transition-colors cursor-pointer"
            data-testid="btn-reschedule-cancel"
          >
            Cancel
          </button>
          <button
            onClick={handleReschedule}
            disabled={submitting}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-lg text-white transition-colors cursor-pointer disabled:opacity-50"
            style={{ backgroundColor: brandColor }}
            data-testid="btn-reschedule-confirm"
          >
            {submitting ? "Rescheduling..." : "Confirm New Time"}
          </button>
        </div>
      )}
    </div>
  );
}

export function InlineBookingCalendar({
  slug,
  memberName,
  brandColor,
  existingBooking: existingBookingProp,
}: {
  slug: string;
  memberName: string;
  brandColor: string;
  existingBooking?: any;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [step, setStep] = useState<"date" | "form" | "pending" | "reschedule" | "cancel_confirm" | "cancelled">(
    existingBookingProp
      ? existingBookingProp.status === "CANCELLED" ? "cancelled" : "pending"
      : "date"
  );
  const [name, setName] = useState(user ? (user as any).name || "" : "");
  const [email, setEmail] = useState(user ? (user as any).email || "" : "");
  const [phone, setPhone] = useState(user ? (user as any).mobileNumber || "" : "");
  const [notes, setNotes] = useState("");
  const [additionalAttendees, setAdditionalAttendees] = useState<{ email: string; name: string; phone: string }[]>([]);
  const [showAttendeeFields, setShowAttendeeFields] = useState(false);
  const [newAttendeeEmail, setNewAttendeeEmail] = useState("");
  const [newAttendeeName, setNewAttendeeName] = useState("");
  const [newAttendeePhone, setNewAttendeePhone] = useState("");
  const [booking, setBooking] = useState<any>(existingBookingProp || null);
  const [cancelling, setCancelling] = useState(false);
  const [rescheduleSlot, setRescheduleSlot] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const prevBookingRef = useRef<{ id?: string; status?: string } | null>(
    existingBookingProp ? { id: existingBookingProp.id, status: existingBookingProp.status } : null
  );

  useEffect(() => {
    if (existingBookingProp) {
      const prev = prevBookingRef.current;
      const changed = !prev || prev.id !== existingBookingProp.id || prev.status !== existingBookingProp.status;
      if (changed) {
        setBooking(existingBookingProp);
        if (existingBookingProp.status === "CANCELLED") {
          setStep("cancelled");
        } else {
          setStep("pending");
        }
        prevBookingRef.current = { id: existingBookingProp.id, status: existingBookingProp.status };
      }
    }
  }, [existingBookingProp]);

  function addAttendee() {
    const trimmed = newAttendeeEmail.trim().toLowerCase();
    if (!trimmed || !/\S+@\S+\.\S+/.test(trimmed)) return;
    if (additionalAttendees.some(a => a.email === trimmed)) return;
    setAdditionalAttendees([...additionalAttendees, { email: trimmed, name: newAttendeeName.trim(), phone: newAttendeePhone.trim() }]);
    setNewAttendeeEmail("");
    setNewAttendeeName("");
    setNewAttendeePhone("");
  }

  function removeAttendee(emailToRemove: string) {
    setAdditionalAttendees(additionalAttendees.filter(a => a.email !== emailToRemove));
  }

  const dateStr = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null;
  const monthStr = format(currentMonth, "yyyy-MM");
  const today = startOfDay(new Date());
  const calendarDays = generateCalendarDays(currentMonth);
  const bookerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const { data: availabilityDays } = useQuery<{ availableDays: number[] }>({
    queryKey: ["/api/calendar/availability-days", slug, monthStr, bookerTimezone],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/availability-days/${slug}?month=${monthStr}&timezone=${bookerTimezone}`, { credentials: "include" });
      if (!res.ok) return { availableDays: [] };
      return res.json();
    },
    enabled: !!slug,
  });

  const availableDaySet = new Set(availabilityDays?.availableDays || []);

  const { data: pageInfo, isLoading: pageLoading } = useQuery({
    queryKey: ["/api/calendar/page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/page/${slug}`);
      if (!res.ok) throw new Error("Booking page not found");
      return res.json();
    },
  });

  const { data: availability, isLoading: slotsLoading } = useQuery({
    queryKey: ["/api/calendar/availability", slug, dateStr, bookerTimezone],
    queryFn: async () => {
      if (!dateStr) return null;
      const res = await fetch(`/api/calendar/availability/${slug}?date=${dateStr}&timezone=${bookerTimezone}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load availability");
      return res.json();
    },
    enabled: !!dateStr,
  });

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDate || !selectedSlot) throw new Error("Select a time");
      const scheduledAt = `${format(selectedDate, "yyyy-MM-dd")}T${selectedSlot}:00`;
      const finalAttendees = [...additionalAttendees];
      if (newAttendeeEmail.trim() && /\S+@\S+\.\S+/.test(newAttendeeEmail.trim())) {
        const trimmed = newAttendeeEmail.trim().toLowerCase();
        if (!finalAttendees.some(a => a.email === trimmed)) {
          finalAttendees.push({ email: trimmed, name: newAttendeeName.trim(), phone: newAttendeePhone.trim() });
        }
      }
      const body: any = {
        scheduledAt,
        name,
        email,
        phone: phone || null,
        notes: notes || null,
        timezone: bookerTimezone,
      };
      if (finalAttendees.length > 0) {
        body.additionalAttendees = finalAttendees.map(a => a.email);
        body.attendeeDetails = Object.fromEntries(finalAttendees.map(a => [a.email, { name: a.name, phone: a.phone }]));
      }
      const res = await apiRequest("POST", `/api/calendar/book/${slug}`, body);
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.publicToken) {
        setBooking(data);
        setStep("pending");
      }
    },
  });

  if (pageLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
      </div>
    );
  }

  if (step === "pending" && booking) {
    const start = new Date(booking.scheduledAt);
    const providerUser = booking.providerUser;
    const providerPhotoSrc = providerUser?.photoUrl
      ? providerUser.photoUrl.startsWith("/uploads") ? providerUser.photoUrl : `/api/uploads/proxy?url=${encodeURIComponent(providerUser.photoUrl)}`
      : null;
    const providerName = providerUser?.name || memberName;
    const providerOrgName = providerUser?.provider?.name || "";
    const isConfirmed = booking.status === "CONFIRMED";
    const participants: { name: string; email: string }[] = [];
    if (booking.attendeeName || booking.attendeeEmails?.[0]) {
      participants.push({ name: booking.attendeeName || booking.attendeeEmails[0], email: booking.attendeeEmails?.[0] || "" });
    }
    if (booking.parentUser && booking.parentUser.email !== booking.attendeeEmails?.[0]) {
      participants.push({ name: booking.parentUser.name || booking.parentUser.email, email: booking.parentUser.email });
    }
    const pam = booking.parentAccountMembers || [];
    const seenEmails = new Set(participants.map(p => p.email.toLowerCase()));
    for (const m of pam) {
      if (seenEmails.has(m.email.toLowerCase())) continue;
      seenEmails.add(m.email.toLowerCase());
      participants.push({ name: m.name || m.email, email: m.email });
    }

    return (
      <div className="space-y-4 py-3" data-testid={isConfirmed ? "inline-booking-confirmed" : "inline-booking-pending"}>
        <div className="text-center space-y-1">
          {isConfirmed ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-[hsl(var(--brand-success,142_71%_45%)/0.12)] flex items-center justify-center">
                <Check className="w-6 h-6 text-[hsl(var(--brand-success,142_71%_45%))]" />
              </div>
              <p className="font-bold text-sm">Confirmed</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success,142_71%_45%)/0.12)] text-[hsl(var(--brand-success,142_71%_45%))]">
                Confirmed
              </span>
            </>
          ) : (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-[hsl(var(--brand-warning,40_96%_53%)/0.12)] flex items-center justify-center">
                <Clock className="w-6 h-6 text-[hsl(var(--brand-warning,40_96%_53%))]" />
              </div>
              <p className="font-bold text-sm">Awaiting Confirmation</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning,40_96%_53%)/0.12)] text-[hsl(var(--brand-warning,40_96%_53%))]">
                Pending
              </span>
            </>
          )}
        </div>

        <div className="bg-muted/40 rounded-xl p-3 space-y-2.5 border border-border">
          <div className="flex items-center gap-3">
            {providerPhotoSrc ? (
              <img src={providerPhotoSrc} alt={providerName} className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                {providerName.charAt(0)}
              </div>
            )}
            <div>
              <p className="text-sm font-semibold">{providerName}</p>
              {providerOrgName && <p className="text-xs text-muted-foreground">{providerOrgName}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <CalendarCheck className="w-4 h-4 text-muted-foreground shrink-0" />
            <span>{format(start, "EEEE, MMMM d, yyyy")}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
            <span>{format(start, "h:mm a")} ({booking.duration || pageInfo?.meetingDuration || 30} min)</span>
          </div>
        </div>

        {participants.length > 0 && (
          <div className="bg-muted/40 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold">Participants</span>
            </div>
            <div className="space-y-1.5">
              {participants.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-sm pl-1">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <span className="font-medium text-xs">{p.name}</span>
                  {p.email && p.name !== p.email && <span className="text-xs text-muted-foreground">({p.email})</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {isConfirmed ? (
          <div className="bg-[hsl(var(--brand-success,142_71%_45%)/0.08)] border border-[hsl(var(--brand-success,142_71%_45%)/0.3)] rounded-xl p-3">
            <p className="text-xs font-medium text-[hsl(var(--brand-success,142_71%_45%))]">Meeting confirmed</p>
            <p className="text-[11px] text-[hsl(var(--brand-success,142_71%_45%))] mt-0.5">Your consultation with {providerName} is confirmed. You'll receive a reminder before the meeting.</p>
          </div>
        ) : (
          <div className="bg-[hsl(var(--brand-warning,40_96%_53%)/0.08)] border border-[hsl(var(--brand-warning,40_96%_53%)/0.3)] rounded-xl p-3">
            <p className="text-xs font-medium text-[hsl(var(--brand-warning,40_96%_53%))]">Awaiting provider confirmation</p>
            <p className="text-[11px] text-[hsl(var(--brand-warning,40_96%_53%))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
          </div>
        )}

        {booking.publicToken && (
          <div className="flex gap-2">
            <button
              onClick={() => { setSelectedDate(null); setSelectedSlot(null); setCurrentMonth(new Date()); setStep("reschedule"); }}
              className="flex-1 text-center text-xs font-medium py-2 rounded-lg border border-border hover:bg-muted transition-colors cursor-pointer"
              data-testid="btn-reschedule-inline"
            >
              Reschedule
            </button>
            <button
              onClick={() => setStep("cancel_confirm")}
              className="flex-1 text-center text-xs font-medium py-2 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/5 transition-colors cursor-pointer"
              data-testid="btn-cancel-inline"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  if (step === "cancel_confirm" && booking) {
    const providerName = booking.providerUser?.name || memberName;
    return (
      <div className="space-y-4 py-3" data-testid="inline-booking-cancel-confirm">
        <div className="text-center space-y-1">
          <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
            <X className="w-6 h-6 text-destructive" />
          </div>
          <p className="font-bold text-sm">Cancel this meeting?</p>
          <p className="text-xs text-muted-foreground">Your consultation with {providerName} will be cancelled and all participants will be notified.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setStep("pending")}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-lg border border-border hover:bg-muted transition-colors cursor-pointer"
            data-testid="btn-cancel-keep"
          >
            Keep Meeting
          </button>
          <button
            onClick={async () => {
              setCancelling(true);
              try {
                const res = await fetch(`/api/calendar/booking/${booking.publicToken}/cancel-public`, { method: "POST", credentials: "include" });
                if (res.ok) {
                  setBooking({ ...booking, status: "CANCELLED" });
                  setStep("cancelled");
                }
              } catch {} finally { setCancelling(false); }
            }}
            disabled={cancelling}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50"
            data-testid="btn-cancel-confirm"
          >
            {cancelling ? "Cancelling..." : "Yes, Cancel"}
          </button>
        </div>
      </div>
    );
  }

  if (step === "cancelled") {
    return (
      <div className="space-y-3 py-3" data-testid="inline-booking-cancelled">
        <div className="text-center space-y-1">
          <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
            <X className="w-6 h-6 text-destructive" />
          </div>
          <p className="font-bold text-sm">Meeting Cancelled</p>
          <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
            Cancelled
          </span>
        </div>
        <p className="text-xs text-center text-muted-foreground">This meeting has been cancelled and all participants have been notified.</p>
        <button
          onClick={() => { setSelectedDate(null); setSelectedSlot(null); setCurrentMonth(new Date()); setBooking(null); setStep("date"); }}
          className="w-full text-center text-xs font-semibold py-2.5 rounded-lg text-white transition-colors cursor-pointer hover:opacity-90"
          style={{ backgroundColor: brandColor }}
          data-testid="btn-book-new-after-cancel"
        >
          Schedule a New Meeting
        </button>
      </div>
    );
  }

  if (step === "reschedule") {
    return (
      <div className="space-y-3 py-2" data-testid="inline-booking-reschedule">
        <button
          onClick={() => setStep("pending")}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          data-testid="btn-back-from-reschedule"
        >
          <ChevronLeft className="w-3 h-3" />
          Back to booking
        </button>
        <p className="text-xs font-semibold text-center">Pick a new date & time</p>
        <RescheduleCalendarPicker
          slug={slug}
          booking={booking}
          brandColor={brandColor}
          onRescheduled={(newBooking) => {
            setBooking(newBooking);
            setStep("pending");
          }}
          onCancel={() => setStep("pending")}
        />
      </div>
    );
  }

  if (step === "form" && selectedDate && selectedSlot) {
    return (
      <div className="space-y-3 py-2">
        <button
          onClick={() => setStep("date")}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          data-testid="button-back-to-dates-inline"
        >
          <ChevronLeft className="w-3 h-3" />
          Back
        </button>
        <div className="bg-muted/50 rounded-lg p-3 flex items-center gap-2 text-sm">
          <CalendarCheck className="w-4 h-4 text-primary shrink-0" />
          <span className="font-medium">{format(selectedDate, "EEE, MMM d")}</span>
          <span className="text-muted-foreground">at {formatTime12(selectedSlot)}</span>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); bookMutation.mutate(); }} className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs font-medium">Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required className="h-9 text-sm" data-testid="input-book-name-inline" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Email *</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-9 text-sm" data-testid="input-book-email-inline" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Phone</Label>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9 text-sm" data-testid="input-book-phone-inline" />
          </div>

          <div className="space-y-2">
            {additionalAttendees.length > 0 && !showAttendeeFields && (
              <div className="space-y-1.5">
                {additionalAttendees.map((ae) => (
                  <div
                    key={ae.email}
                    className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-lg px-2.5 py-2"
                    data-testid={`attendee-chip-inline-${ae.email}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{ae.name || ae.email}</p>
                      {ae.name && <p className="text-[11px] text-muted-foreground truncate">{ae.email}</p>}
                      {ae.phone && <p className="text-[11px] text-muted-foreground">{ae.phone}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttendee(ae.email)}
                      className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      data-testid={`button-remove-attendee-inline-${ae.email}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!showAttendeeFields ? (
              <button
                type="button"
                onClick={() => setShowAttendeeFields(true)}
                className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
                data-testid="button-show-attendee-fields-inline"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Add Additional Attendees
              </button>
            ) : (
              <div className="space-y-2 bg-muted/30 border border-border rounded-lg p-3">
                <Label className="flex items-center gap-1.5 text-xs font-medium">
                  <UserPlus className="w-3.5 h-3.5" />
                  Additional Attendees
                </Label>
                <p className="text-[10px] text-muted-foreground leading-tight">
                  Invite others to this meeting. They'll receive all notifications.
                </p>
                {additionalAttendees.length > 0 && (
                  <div className="space-y-1.5">
                    {additionalAttendees.map((ae) => (
                      <div
                        key={ae.email}
                        className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-lg px-2.5 py-2"
                        data-testid={`attendee-chip-inline-${ae.email}`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{ae.name || ae.email}</p>
                          {ae.name && <p className="text-[11px] text-muted-foreground truncate">{ae.email}</p>}
                          {ae.phone && <p className="text-[11px] text-muted-foreground">{ae.phone}</p>}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeAttendee(ae.email)}
                          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          data-testid={`button-remove-attendee-inline-${ae.email}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Input
                    type="email"
                    value={newAttendeeEmail}
                    onChange={(e) => setNewAttendeeEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); addAttendee(); }
                    }}
                    placeholder="Email address *"
                    className="h-8 text-xs"
                    data-testid="input-additional-attendee-inline"
                  />
                  <div className="flex gap-1.5">
                    <Input
                      type="text"
                      value={newAttendeeName}
                      onChange={(e) => setNewAttendeeName(e.target.value)}
                      placeholder="Full Name (optional)"
                      className="h-8 text-xs flex-1"
                      data-testid="input-additional-attendee-name-inline"
                    />
                    <Input
                      type="tel"
                      value={newAttendeePhone}
                      onChange={(e) => setNewAttendeePhone(e.target.value)}
                      placeholder="Mobile (optional)"
                      className="h-8 text-xs flex-1"
                      data-testid="input-additional-attendee-phone-inline"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addAttendee}
                    className="h-8 w-full gap-1.5 text-xs"
                    disabled={!newAttendeeEmail.trim()}
                    data-testid="button-add-attendee-inline"
                  >
                    <Plus className="w-3 h-3" />
                    Add Attendee
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAttendeeFields(false)}
                  className="h-6 w-full text-[11px] text-muted-foreground"
                  data-testid="button-close-attendee-fields-inline"
                >
                  Done
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-sm resize-none" placeholder="Anything you'd like to share..." data-testid="input-book-notes-inline" />
          </div>
          {bookMutation.isError && (
            <p className="text-xs text-destructive">{(bookMutation.error as Error).message}</p>
          )}
          <Button
            type="submit"
            className="w-full h-10 text-sm font-semibold text-white"
            style={{ backgroundColor: brandColor }}
            disabled={bookMutation.isPending}
            data-testid="button-confirm-booking-inline"
          >
            {bookMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm Booking"}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-1" data-testid="inline-booking-calendar">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="w-3.5 h-3.5" />
        <span>{pageInfo?.meetingDuration || 30} min</span>
        <span className="mx-1">·</span>
        <Video className="w-3.5 h-3.5" />
        <span>Video call</span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            data-testid="button-prev-month-inline"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-semibold">{format(currentMonth, "MMMM yyyy")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            data-testid="button-next-month-inline"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="text-[10px] font-medium text-muted-foreground/60 py-1 uppercase">{d}</div>
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
                className={`relative w-8 h-8 rounded-full text-xs transition-all mx-auto flex items-center justify-center ${
                  !day.isCurrentMonth ? "text-muted-foreground/20" :
                  isPast || noAvailability ? "text-muted-foreground/30 cursor-not-allowed" :
                  isSelected ? "bg-primary text-primary-foreground font-semibold shadow-md" :
                  isTodayDate ? "text-primary font-semibold hover:bg-primary/10 cursor-pointer" :
                  "hover:bg-muted cursor-pointer text-foreground/80"
                }`}
                data-testid={`day-inline-${format(day.date, "yyyy-MM-dd")}`}
              >
                {day.date.getDate()}
                {isTodayDate && !isSelected && (
                  <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-foreground/80">{format(selectedDate, "EEEE, MMMM d")}</p>
          {slotsLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
            </div>
          ) : availability?.slots?.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No available times on this date.</p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {availability?.slots?.map((slot: any) => (
                <button
                  key={slot.time}
                  onClick={() => { setSelectedSlot(slot.time); setStep("form"); }}
                  className="px-2 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer bg-muted/50 border border-border hover:bg-primary/10 hover:border-primary/40 text-foreground/80"
                  data-testid={`slot-inline-${slot.time}`}
                >
                  {formatTime12(slot.time)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConsultationBookingCard({
  card,
  brandColor,
  onSchedule,
  existingBooking,
}: {
  card: ConsultationCardData;
  brandColor: string;
  onSchedule: (card: ConsultationCardData) => void;
  existingBooking?: any;
}) {
  if (card.memberBookingSlug) {
    return (
      <div
        className="w-full animate-[slideUp_0.4s_ease-out_forwards] overflow-hidden border border-border bg-card"
        style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
        data-testid="consultation-booking-card"
      >
        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <CalendarCheck className="w-4 h-4 text-white" />
            <span className="text-white text-xs font-semibold uppercase tracking-wider">
              {existingBooking && existingBooking.status !== "CANCELLED" ? "Meeting Scheduled" : "Schedule a Free Consultation"}
            </span>
          </div>
        </div>
        <div className="px-4 pb-4">
          <InlineBookingCalendar
            slug={card.memberBookingSlug}
            memberName={card.memberName || card.providerName}
            brandColor={brandColor}
            existingBooking={existingBooking}
          />
        </div>
      </div>
    );
  }

  return (
    <Card
      className="overflow-hidden max-w-sm animate-[slideUp_0.4s_ease-out_forwards]"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid="consultation-booking-card"
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <CalendarCheck className="w-4 h-4 text-white" />
          <span className="text-white text-xs font-semibold uppercase tracking-wider">Book a Consultation</span>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          {card.providerLogo ? (
            <img
              src={card.providerLogo.startsWith("/") ? card.providerLogo : `/api/uploads/proxy?url=${encodeURIComponent(card.providerLogo)}`}
              alt={card.providerName}
              className="w-12 h-12 rounded-full object-cover border-2"
              style={{ borderColor: `${brandColor}30` }}
            />
          ) : (
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-white text-lg font-bold"
              style={{ backgroundColor: brandColor }}
            >
              {card.providerName.charAt(0)}
            </div>
          )}
          <div>
            <p className="font-semibold text-sm">{card.providerName}</p>
            <p className="text-xs text-muted-foreground">Ready to connect</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Take the next step in your journey. Schedule a consultation to discuss your options directly with {card.providerName}.
        </p>
        <Button
          className="w-full gap-2 text-white"
          style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
          onClick={() => onSchedule(card)}
          data-testid="btn-schedule-consultation"
        >
          <CalendarCheck className="w-4 h-4" />
          Schedule Consultation
        </Button>
      </div>
    </Card>
  );
}

function BookingOverlay({
  card,
  brandColor,
  userEmail,
  userName,
  onClose,
}: {
  card: ConsultationCardData;
  brandColor: string;
  userEmail: string;
  userName: string;
  onClose: () => void;
}) {
  const [callbackName, setCallbackName] = useState(userName);
  const [callbackEmail, setCallbackEmail] = useState(userEmail);
  const [callbackMessage, setCallbackMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const hasBookingUrl = !!card.bookingUrl;
  const useIframe = hasBookingUrl && card.iframeEnabled;

  const [error, setError] = useState("");

  async function handleCallbackSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/consultation/request-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          providerId: card.providerId,
          providerName: card.providerName,
          name: callbackName,
          email: callbackEmail,
          message: callbackMessage,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: "Request failed" }));
        setError(data.message || "Something went wrong. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" data-testid="booking-overlay">
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ backgroundColor: `${brandColor}08` }}
      >
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" style={{ color: brandColor }} />
          <span className="font-semibold text-sm">
            {useIframe ? `Book with ${card.providerName}` : `Request Callback — ${card.providerName}`}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          data-testid="btn-close-booking"
        >
          <X className="w-5 h-5" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {useIframe ? (
          <iframe
            src={card.bookingUrl!}
            className="w-full h-full border-0"
            title={`Book consultation with ${card.providerName}`}
            allow="payment"
            data-testid="booking-iframe"
          />
        ) : hasBookingUrl && !card.iframeEnabled ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-4">
            <CalendarCheck className="w-12 h-12" style={{ color: brandColor }} />
            <h3 className="text-lg font-semibold">Schedule with {card.providerName}</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Click below to open the scheduling page in a new tab and book your consultation.
            </p>
            <a
              href={card.bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 text-white text-sm font-medium transition-opacity hover:opacity-90"
              style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
              data-testid="link-external-booking"
            >
              <ExternalLink className="w-4 h-4" />
              Open Scheduling Page
            </a>
            <Button variant="outline" onClick={onClose} className="mt-2" data-testid="btn-back-to-chat">
              Back to Chat
            </Button>
          </div>
        ) : submitted ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-4">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{ backgroundColor: `${brandColor}15` }}
            >
              <CalendarCheck className="w-8 h-8" style={{ color: brandColor }} />
            </div>
            <h3 className="text-lg font-semibold">Request Sent!</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              We've sent your consultation request to {card.providerName}. They'll reach out to you shortly.
            </p>
            <Button
              onClick={onClose}
              style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
              className="text-white mt-2"
              data-testid="btn-back-to-chat-after-submit"
            >
              Back to Chat
            </Button>
          </div>
        ) : (
          <div className="max-w-md mx-auto p-6 space-y-4">
            <h3 className="text-lg font-semibold">Request a Callback</h3>
            <p className="text-sm text-muted-foreground">
              {card.providerName} doesn't have online booking set up yet. Fill out this form and they'll reach out to schedule your consultation.
            </p>
            <form onSubmit={handleCallbackSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Your Name</Label>
                <Input
                  value={callbackName}
                  onChange={e => setCallbackName(e.target.value)}
                  required
                  data-testid="input-callback-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={callbackEmail}
                  onChange={e => setCallbackEmail(e.target.value)}
                  required
                  data-testid="input-callback-email"
                />
              </div>
              <div className="space-y-2">
                <Label>Message (optional)</Label>
                <Textarea
                  value={callbackMessage}
                  onChange={e => setCallbackMessage(e.target.value)}
                  placeholder="Tell them a bit about what you're looking for..."
                  rows={3}
                  data-testid="input-callback-message"
                />
              </div>
              <Button
                type="submit"
                className="w-full text-white gap-2"
                style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
                disabled={submitting}
                data-testid="btn-submit-callback"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {submitting ? "Sending..." : "Request Callback"}
              </Button>
              {error && (
                <p className="text-sm text-destructive text-center" data-testid="callback-error">{error}</p>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function getProfileUrlSlug(type: string): string {
  const t = type.toLowerCase();
  if (t === "surrogate") return "surrogate";
  if (t === "egg donor") return "eggdonor";
  if (t === "sperm donor") return "spermdonor";
  return "surrogate";
}

function getProfileEndpoint(type: string): string {
  const t = type.toLowerCase();
  if (t === "surrogate") return "surrogates";
  if (t === "egg donor") return "egg-donors";
  if (t === "sperm donor") return "sperm-donors";
  return "surrogates";
}

function buildMatchTabs(profile: any, cardType: string, reasons: string[]): TabSection[] {
  const t = cardType.toLowerCase();
  const isSurrogate = t === "surrogate";

  const swipeProfile = isSurrogate
    ? mapDatabaseSurrogateToSwipeProfile(profile)
    : t === "sperm donor"
      ? mapDatabaseSpermDonorToSwipeProfile(profile)
      : mapDatabaseDonorToSwipeProfile(profile);

  const baseTabs = isSurrogate
    ? getSurrogateTabs(swipeProfile, [])
    : getDonorTabs(swipeProfile, []);

  if (reasons.length > 0) {
    const matchTab: TabSection = {
      layoutType: "matched_bubbles",
      title: `Matched ${reasons.length} Preference${reasons.length !== 1 ? "s" : ""}`,
      items: reasons.map(r => ({ label: r, value: "" })),
    };
    return [matchTab, ...baseTabs];
  }

  return baseTabs;
}

function MatchCardComponent({ card, brandColor, onAction, onViewProfile }: { card: MatchCard; brandColor: string; onAction: (text: string) => void; onViewProfile: (card: MatchCard) => void }) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!card.ownerProviderId) { setLoading(false); return; }
      try {
        const endpoint = getProfileEndpoint(card.type);
        const res = await fetch(`/api/providers/${card.ownerProviderId}/${endpoint}/${card.providerId}`, { credentials: "include" });
        if (res.ok) setProfile(await res.json());
      } catch {}
      setLoading(false);
    };
    fetchProfile();
  }, [card.ownerProviderId, card.providerId, card.type]);

  if (loading) {
    return (
      <div className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile) {
    const t = card.type.toLowerCase();
    const swipeProfile = t === "surrogate"
      ? mapDatabaseSurrogateToSwipeProfile(profile)
      : t === "sperm donor"
        ? mapDatabaseSpermDonorToSwipeProfile(profile)
        : mapDatabaseDonorToSwipeProfile(profile);
    const photos = getPhotoList(swipeProfile);
    const title = buildTitle(swipeProfile);
    const statusLabel = buildStatusLabel(swipeProfile);
    const tabs = buildMatchTabs(profile, card.type, card.reasons);

    return (
      <div
        className="w-full max-w-sm aspect-[3/4] animate-[slideUp_0.4s_ease-out_forwards]"
        data-testid={`match-card-${card.providerId}`}
      >
        <SwipeDeckCard
          id={card.providerId}
          photos={photos}
          title={title}
          statusLabel={statusLabel}
          isExperienced={swipeProfile.isExperienced}
          isPremium={swipeProfile.isPremium}
          tabs={tabs}
          disableSwipe
          chatMode
          onPass={() => onAction(`I'm not interested in ${card.name || title}. Show me another option.`)}
          onSave={() => onAction(`I like ${card.name || title}! Save as favorite. ❤️`)}
          onViewFullProfile={() => onViewProfile(card)}
        />
      </div>
    );
  }

  return (
    <div
      className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted cursor-pointer relative"
      data-testid={`match-card-${card.providerId}`}
      onClick={() => onViewProfile(card)}
    >
      {card.photo && (
        <img src={card.photo} alt={card.name} className="w-full h-full object-cover" />
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
        <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
        {card.location && (
          <p className="text-white/70 text-sm mt-1">{card.location}</p>
        )}
      </div>
    </div>
  );
}

function ConciergeInlineVideoOverlay({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!overlayRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      overlayRef.current.requestFullscreen().catch(() => {});
    }
  };

  return (
    <div
      ref={overlayRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: "hsl(var(--background))",
      }}
      data-testid="inline-video-overlay"
    >
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10001, display: "flex", gap: 4 }}>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full bg-background/80 hover:bg-background border shadow-sm"
          onClick={toggleFullscreen}
          data-testid="button-fullscreen-video"
        >
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full bg-background/80 hover:bg-background border shadow-sm"
          onClick={onClose}
          data-testid="button-close-inline-video"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
      <iframe
        src={`/video/${bookingId}`}
        style={{ width: "100%", height: "100%", border: "none" }}
        allow="camera *; microphone *; autoplay *; display-capture *; fullscreen *"
        data-testid="inline-video-iframe"
      />
    </div>
  );
}

function ConciergeSpecialCard({ msg, brandColor, onOpenInlineVideo }: { msg: ChatMessage; brandColor: string; onOpenInlineVideo?: (bookingId: string) => void }) {
  const data = msg.uiCardData as any;
  if (!data) return null;

  if (msg.uiCardType === "attachment") {
    const isImage = data.mimeType?.startsWith("image/");
    return (
      <div data-testid="concierge-attachment-card">
        {isImage ? (
          <a href={data.url} target="_blank" rel="noopener noreferrer">
            <img src={data.url} alt={data.originalName} className="max-w-[240px] rounded-lg border" />
          </a>
        ) : (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted transition-colors"
          >
            <FileText className="w-5 h-5 shrink-0" style={{ color: brandColor }} />
            <span className="text-sm font-medium truncate">{data.originalName || "File"}</span>
            <Download className="w-4 h-4 shrink-0 text-muted-foreground" />
          </a>
        )}
      </div>
    );
  }

  if (msg.uiCardType === "video_invite") {
    const videoBookingId = data.bookingId;
    if (!videoBookingId) {
      return (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-muted/50 w-full text-left opacity-60" style={{ borderColor: brandColor }}>
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white/70 shrink-0" style={{ backgroundColor: brandColor }}>
            <Video className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-muted-foreground">Video Call Ended</p>
            <p className="text-xs text-muted-foreground">This call session has expired</p>
          </div>
        </div>
      );
    }
    const handleVideoClick = (e: React.MouseEvent) => {
      e.preventDefault();
      if (onOpenInlineVideo) {
        onOpenInlineVideo(videoBookingId);
      }
    };
    return (
      <button
        onClick={handleVideoClick}
        className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-background hover:bg-muted transition-colors cursor-pointer w-full text-left"
        style={{ borderColor: brandColor }}
        data-testid="concierge-video-invite"
      >
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0" style={{ backgroundColor: brandColor }}>
          <Video className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Join Video Call</p>
          <p className="text-xs text-muted-foreground">Click to join the video consultation</p>
        </div>
        <Video className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
    );
  }

  if (msg.uiCardType === "calendar_share") {
    return (
      <a
        href={data.bookingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-background hover:bg-muted transition-colors"
        style={{ borderColor: brandColor }}
        data-testid="concierge-calendar-share"
      >
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0" style={{ backgroundColor: brandColor }}>
          <CalendarDays className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Book a Meeting</p>
          <p className="text-xs text-muted-foreground">{data.memberName ? `Schedule with ${data.memberName}` : "Pick a time that works"}</p>
        </div>
        <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
      </a>
    );
  }

  return null;
}

interface ConciergeChatProps {
  inlineSessionId?: string;
  inlineMatchmakerId?: string;
  isInline?: boolean;
  externalBookingSlug?: { slug: string; memberName: string } | null;
  onCloseExternalBooking?: () => void;
}

export default function ConciergeChatPage({ inlineSessionId, inlineMatchmakerId, isInline, externalBookingSlug, onCloseExternalBooking }: ConciergeChatProps = {}) {
  const [searchParams] = useSearchParams();
  const matchmakerId = isInline ? (inlineMatchmakerId || null) : searchParams.get("matchmaker");
  const existingSessionId = isInline ? (inlineSessionId || null) : searchParams.get("session");
  const isEmbedded = isInline || searchParams.get("embedded") === "1";
  const donorIdParam = searchParams.get("donorId");
  const donorTypeParam = searchParams.get("donorType");
  const donorProviderIdParam = searchParams.get("providerId");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [multiSelectChoices, setMultiSelectChoices] = useState<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(existingSessionId);
  const [showCuration, setShowCuration] = useState(false);
  const [pendingCurationMessage, setPendingCurationMessage] = useState<ChatMessage | null>(null);
  const [humanEscalated, setHumanEscalated] = useState(false);
  const [bookingCard, setBookingCard] = useState<ConsultationCardData | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [greetingSet, setGreetingSet] = useState(false);
  const [providerInChat, setProviderInChat] = useState(false);
  const [providerChatName, setProviderChatName] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [conciergeBookingSlug, setConciergeBookingSlug] = useState<{ slug: string; memberName: string } | null>(null);
  const parentFileInputRef = useRef<HTMLInputElement>(null);
  const [parentUploading, setParentUploading] = useState(false);

  const { data: sessionBookings } = useQuery<any[]>({
    queryKey: ["/api/chat-session", sessionId, "bookings"],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${sessionId}/bookings`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!sessionId,
    refetchInterval: 10000,
  });

  const { data: sessionCalendarSlug } = useQuery<{ slug: string | null; memberName: string | null }>({
    queryKey: ["/api/chat-session", sessionId, "provider-calendar-slug"],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${sessionId}/provider-calendar-slug`, { credentials: "include" });
      if (!res.ok) return { slug: null, memberName: null };
      return res.json();
    },
    enabled: !!sessionId,
    staleTime: 60000,
  });

  const myDisplayName = useMemo(() => {
    const u = user as any;
    if (!u?.name) return "";
    const parts = u.name.trim().split(/\s+/);
    return parts.length >= 2
      ? `${parts[0]} ${parts[parts.length - 1][0]}.`
      : parts[0] || "";
  }, [user]);
  const handleViewProfile = useCallback((card: MatchCard) => {
    if (!card.ownerProviderId) return;
    const slug = getProfileUrlSlug(card.type);
    const profileUrl = `/${slug}/${card.ownerProviderId}/${card.providerId}`;
    navigate(profileUrl, {
      state: {
        fromChat: true,
        matchReasons: card.reasons || [],
        chatPath: window.location.pathname + window.location.search,
      },
    });
  }, [navigate]);

  const handleConciergeMeeting = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/chat-session/${sessionId}/provider-calendar-slug`, { credentials: "include" });
      const data = await res.json();
      if (data.slug) {
        setConciergeBookingSlug({ slug: data.slug, memberName: data.memberName || "Provider" });
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
      } else {
        alert("This provider hasn't set up online scheduling yet. You can message them to arrange a meeting.");
      }
    } catch {
      alert("Failed to load calendar. Please try again.");
    }
  }, [sessionId]);

  const [inlineVideoBookingId, setInlineVideoBookingId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "video-call-ended") {
        setInlineVideoBookingId(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleConciergeVideo = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch("/api/video/chat-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error("Failed");
      const { bookingId } = await res.json();
      setInlineVideoBookingId(bookingId);
    } catch {
      alert("Failed to start video call. Please try again.");
    }
  }, [sessionId]);

  const handleParentFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !sessionId) return;
    e.target.value = "";
    setParentUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const uploadData = await uploadRes.json();
      await fetch(`/api/chat-session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          content: uploadData.originalName ? `Shared a file: ${uploadData.originalName}` : "Shared a file",
          uiCardType: "attachment",
          uiCardData: uploadData,
        }),
      });
    } catch {
      alert("Failed to upload file. Please try again.");
    } finally {
      setParentUploading(false);
    }
  }, [sessionId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const lastPollTimeRef = useRef<string | null>(null);
  const knownMessageIds = useRef<Set<string>>(new Set());

  const matchmakers: Matchmaker[] = brand?.matchmakers || [];
  const [resolvedMatchmakerId, setResolvedMatchmakerId] = useState<string | null>(null);
  const effectiveMatchmakerId = matchmakerId || resolvedMatchmakerId
    || (donorIdParam && matchmakers.find(m => m.isActive)?.id) || null;
  const selectedMatchmaker = matchmakers.find((m) => m.id === effectiveMatchmakerId);
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);

  const loadMessagesForSession = async (sid: string) => {
    try {
      const res = await fetch(`/api/ai-concierge/session/${sid}/messages`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const msgs = Array.isArray(data) ? data : (data.messages || []);
      setSessionTitle(data.sessionTitle || null);
      if (data.providerName) setProviderChatName(data.providerName);
      if (msgs.length > 0) {
        const parsed: ChatMessage[] = msgs.map((m: any) => {
          const extras = m.uiCardData || {};
          return {
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            senderType: m.senderType,
            senderName: m.senderName,
            matchCards: extras.matchCards,
            prepDoc: extras.prepDoc,
            consultationCard: extras.consultationCard,
            uiCardType: m.uiCardType,
            uiCardData: m.uiCardData,
            createdAt: m.createdAt,
          };
        });
        setMessages(parsed);
        setGreetingSet(true);
        lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
        msgs.forEach((m: any) => { if (m.id) knownMessageIds.current.add(m.id); });
        if (msgs.some((m: any) => m.senderType === "human")) setHumanEscalated(true);
        const providerMsg = msgs.find((m: any) => m.senderType === "provider");
        if (providerMsg) {
          setProviderInChat(true);
        }
      }
    } catch {}
  };

  useEffect(() => {
    if (sessionLoaded) return;

    if (existingSessionId) {
      (async () => {
        await loadMessagesForSession(existingSessionId);
        setSessionLoaded(true);
      })();
      return;
    }

    (async () => {
      try {
        const sessRes = await fetch("/api/ai-concierge/my-session", { credentials: "include" });
        if (sessRes.ok) {
          const data = await sessRes.json();
          if (data.session) {
            setSessionId(data.session.id);
            if (matchmakerId && data.session.matchmakerId !== matchmakerId) {
              fetch("/api/my/chat-session/matchmaker", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ matchmakerId }),
              });
              setResolvedMatchmakerId(matchmakerId);
            } else if (data.session.matchmakerId) {
              setResolvedMatchmakerId(data.session.matchmakerId);
            }
            if (!donorIdParam && data.messages?.length > 0) {
              const msgs = data.messages;
              setSessionTitle(data.session.title || null);
              if (data.session.providerName) setProviderChatName(data.session.providerName);
              const parsed: ChatMessage[] = msgs.map((m: any) => {
                const extras = m.uiCardData || {};
                return {
                  id: m.id,
                  role: m.role as "user" | "assistant",
                  content: m.content,
                  senderType: m.senderType,
                  senderName: m.senderName,
                  matchCards: extras.matchCards,
                  prepDoc: extras.prepDoc,
                  consultationCard: extras.consultationCard,
                  uiCardType: m.uiCardType,
                  uiCardData: m.uiCardData,
                  createdAt: m.createdAt,
                };
              });
              setMessages(parsed);
              setGreetingSet(true);
              lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
              msgs.forEach((m: any) => { if (m.id) knownMessageIds.current.add(m.id); });
              if (msgs.some((m: any) => m.senderType === "human")) setHumanEscalated(true);
              if (msgs.find((m: any) => m.senderType === "provider")) setProviderInChat(true);
            }
          }
        }
      } catch {}
      setSessionLoaded(true);
    })();
  }, [existingSessionId, matchmakerId, donorIdParam, sessionLoaded]);

  useEffect(() => {
    window.scrollTo(0, document.body.scrollHeight);
  }, []);

  const parentProfileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!user,
  });

  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!messages.length) return;
    if (!initialScrollDone.current) {
      const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
      scrollToBottom();
      const t1 = setTimeout(scrollToBottom, 100);
      const t2 = setTimeout(scrollToBottom, 300);
      const t3 = setTimeout(() => {
        scrollToBottom();
        initialScrollDone.current = true;
      }, 600);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if (externalBookingSlug) {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  }, [externalBookingSlug]);

  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(async () => {
      if (sendingRef.current) return;
      try {
        const afterParam = lastPollTimeRef.current ? `?after=${encodeURIComponent(lastPollTimeRef.current)}` : "";
        const res = await fetch(`/api/ai-concierge/session/${sessionId}/messages${afterParam}`, { credentials: "include" });
        if (!res.ok) return;
        const rawData = await res.json();
        const newMsgs = Array.isArray(rawData) ? rawData : (rawData.messages || []);
        if (rawData.sessionTitle !== undefined) setSessionTitle(rawData.sessionTitle);
        if (rawData.providerName) setProviderChatName(rawData.providerName);
        const unseenMsgs = newMsgs.filter((m: any) => m.id && !knownMessageIds.current.has(m.id));
        if (unseenMsgs.length > 0) {
          unseenMsgs.forEach((m: any) => knownMessageIds.current.add(m.id));
          setMessages((prev) => [
            ...prev,
            ...unseenMsgs.map((m: any) => {
              const extras = m.uiCardData || {};
              return {
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
                senderType: m.senderType as string | undefined,
                senderName: m.senderName || (m.senderType === "human" ? "GoStork Expert" : m.senderType === "provider" ? m.senderName : undefined),
                matchCards: extras.matchCards,
                prepDoc: extras.prepDoc,
                consultationCard: extras.consultationCard,
                quickReplies: extras.quickReplies,
                multiSelect: extras.multiSelect,
                uiCardType: m.uiCardType,
                uiCardData: m.uiCardData,
                createdAt: m.createdAt,
              };
            }),
          ]);
          lastPollTimeRef.current = unseenMsgs[unseenMsgs.length - 1].createdAt;
          if (unseenMsgs.some((m: any) => m.senderType === "human")) setHumanEscalated(true);
          if (unseenMsgs.some((m: any) => m.senderType === "provider" || m.senderType === "system")) {
            setProviderInChat(true);
          }
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const profileReady = !parentProfileQuery.isLoading;

  useEffect(() => {
    if (greetingSet || !selectedMatchmaker || !user) return;
    if (!donorIdParam && !profileReady) return;
    if (!sessionLoaded) return;
    if (!donorIdParam && (sessionId || existingSessionId)) return;
    let greeting = selectedMatchmaker.initialGreeting
      || `Hi there! I'm ${selectedMatchmaker.name}, ${selectedMatchmaker.title.toLowerCase()}. ${selectedMatchmaker.description} How can I help you on your fertility journey today?`;
    const u = user as any;
    const firstName = u.firstName || u.name?.split(" ")[0] || "there";
    const city = u.city || "";
    const state = u.state || "";
    const location = city && state ? `${city}, ${state}` : city || state || "your area";
    const services = parentProfileQuery.data?.interestedServices || [];
    const service = services.length ? services.join(" and ") : "fertility services";
    greeting = greeting
      .replace(/\[First Name\]/gi, firstName)
      .replace(/\[Service\]/gi, service)
      .replace(/\[Location\]/gi, location);

    let greetingMatchCards: MatchCard[] | undefined;
    if (donorIdParam) {
      const donorLabel = donorTypeParam === "surrogate" ? "Surrogate" : donorTypeParam === "sperm-donor" ? "Sperm Donor" : "Egg Donor";
      greeting = `Hi ${firstName}! I see you're interested in learning more about a ${donorLabel} profile. I'd love to help you with any questions you have. Do you have a specific question about this ${donorLabel.toLowerCase()}?`;
      greetingMatchCards = [{
        name: donorLabel,
        type: donorLabel,
        providerId: donorIdParam,
        ownerProviderId: donorProviderIdParam || undefined,
        reasons: [],
      }];
    }

    setMessages([{ role: "assistant", content: greeting, createdAt: new Date().toISOString(), matchCards: greetingMatchCards }]);
    setGreetingSet(true);

    (async () => {
      try {
        const initBody: any = { matchmakerId: effectiveMatchmakerId, greeting };
        if (donorIdParam) {
          initBody.donorId = donorIdParam;
          initBody.donorType = donorTypeParam;
          initBody.ownerProviderId = donorProviderIdParam || undefined;
        }
        const res = await fetch("/api/ai-concierge/init-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(initBody),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.sessionId) setSessionId(data.sessionId);
          if (data.greetingMessageId) knownMessageIds.current.add(data.greetingMessageId);
        }
      } catch {}
    })();
  }, [selectedMatchmaker, user, profileReady, greetingSet, parentProfileQuery.data, sessionLoaded, sessionId, existingSessionId, donorIdParam, donorTypeParam]);

  if (!effectiveMatchmakerId && !existingSessionId && !sessionId && sessionLoaded) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center" data-testid="concierge-no-matchmaker">
        <Sparkles className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-xl font-semibold mb-2">No Matchmaker Selected</h2>
        <p className="text-muted-foreground text-sm mb-4">
          Please choose an AI guide to start your concierge experience.
        </p>
        <Button onClick={() => navigate("/account/concierge")} data-testid="btn-go-select-matchmaker">
          Choose a Concierge
        </Button>
      </div>
    );
  }

  const sendMessage = async (text: string) => {
    if (!text.trim() || sending || sendingRef.current || showCuration) return;
    sendingRef.current = true;
    const userMessage = text.trim();
    setInput("");
    setMessages((prev) => {
      const updated = prev.map((m, i) =>
        i === prev.length - 1 && m.quickReplies ? { ...m, quickReplies: undefined } : m
      );
      return [...updated, { role: "user" as const, content: userMessage, createdAt: new Date().toISOString() }];
    });
    setSending(true);

    try {
      const res = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: userMessage,
          sessionId,
          matchmakerId: effectiveMatchmakerId,
        }),
      });

      if (!res.ok) throw new Error("Chat request failed");
      const data = await res.json();
      if (data.sessionId && data.sessionId !== sessionId) {
        setSessionId(data.sessionId);
        queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
      }

      if (data.userMessageId) knownMessageIds.current.add(data.userMessageId);

      if (data.skipAiResponse) {
        setSending(false);
        sendingRef.current = false;
        return;
      }

      if (data.humanNeeded) {
        setHumanEscalated(true);
      }
      if (data.consultationCard) {
        setProviderInChat(true);
      }

      if (data.message.id) knownMessageIds.current.add(data.message.id);

      const newMessage: ChatMessage = {
        role: "assistant",
        content: data.message.content,
        id: data.message.id,
        quickReplies: data.quickReplies,
        multiSelect: data.multiSelect,
        matchCards: data.matchCards,
        prepDoc: data.prepDoc,
        consultationCard: data.consultationCard,
        senderType: data.message.senderType,
        senderName: data.message.senderName,
        createdAt: data.message.createdAt || new Date().toISOString(),
      };

      if (data.showCuration) {
        setMessages((prev) => [...prev, newMessage]);
        setPendingCurationMessage(newMessage);
        setTimeout(() => setShowCuration(true), 2000);
      } else {
        setMessages((prev) => [...prev, newMessage]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I'm sorry, I'm having trouble connecting right now. Please try again.", createdAt: new Date().toISOString() },
      ]);
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };

  const handleSend = () => sendMessage(input);

  const handleQuickReply = (text: string) => {
    sendMessage(text);
  };

  const handleTalkToTeam = () => {
    sendMessage("I'd like to talk to a real person on the GoStork team");
  };

  const handleCurationComplete = useCallback(() => {
    setShowCuration(false);
    if (pendingCurationMessage) {
      setPendingCurationMessage(null);
      sendMessage("ready");
    }
  }, [pendingCurationMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {showCuration && (
        <CurationOverlay brandColor={brandColor} onComplete={handleCurationComplete} />
      )}
      <div className={`flex flex-col ${isInline ? "h-full" : "h-dvh"} ${isEmbedded ? "" : "max-w-3xl mx-auto"} overflow-hidden`} data-testid="concierge-chat-page">
        {!isEmbedded && <div
          className="flex items-center gap-3 px-4 py-3 border-b shrink-0"
          data-testid="concierge-chat-header"
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => navigate("/chat")}
            data-testid="btn-back-to-chats"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="w-9 h-9 rounded-full flex-shrink-0 relative">
            {!providerInChat && selectedMatchmaker?.avatarUrl && (
              <img
                src={selectedMatchmaker.avatarUrl}
                alt={selectedMatchmaker.name}
                className="w-9 h-9 rounded-full object-cover border absolute inset-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            )}
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: brandColor }}
            >
              {(providerInChat && providerChatName ? providerChatName : (selectedMatchmaker?.name || "?")).charAt(0)}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-ui" style={{ fontWeight: 600 }}>
              {providerInChat && providerChatName ? providerChatName : (selectedMatchmaker?.name || "AI Concierge")}
            </h2>
            {sessionTitle && (
              <p className="text-[11px] font-ui text-muted-foreground truncate" data-testid="chat-subject-label">
                Subject: {sessionTitle}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {providerInChat && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 sm:h-8 px-2.5 sm:px-2 gap-1.5 font-ui text-xs"
                  style={{ color: brandColor }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  onClick={handleConciergeMeeting}
                  data-testid="btn-meeting"
                >
                  <CalendarDays className="w-5 h-5 sm:w-3.5 sm:h-3.5" />
                  <span className="hidden sm:inline">Meeting</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 sm:h-8 px-2.5 sm:px-2 gap-1.5 font-ui text-xs"
                  style={{ color: brandColor }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  onClick={handleConciergeVideo}
                  data-testid="btn-video"
                >
                  <Video className="w-5 h-5 sm:w-3.5 sm:h-3.5" />
                  <span className="hidden sm:inline">Video</span>
                </Button>
              </>
            )}
            {!providerInChat && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1.5 h-8"
                style={{ borderColor: `${brandColor}30`, color: brandColor, borderRadius: "999px" }}
                onClick={handleTalkToTeam}
                disabled={sending || humanEscalated}
                data-testid="btn-talk-to-team"
              >
                <Headphones className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{humanEscalated ? "Team Notified" : "Talk to GoStork Team"}</span>
              </Button>
            )}
          </div>
        </div>}

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" data-testid="concierge-messages">
          {(() => {
            const shouldInlineBooking = !externalBookingSlug && !conciergeBookingSlug && sessionBookings && sessionBookings.length > 0;
            const activeBooking = shouldInlineBooking
              ? (sessionBookings!.find((b: any) => b.status === "CONFIRMED")
                || sessionBookings!.find((b: any) => b.status === "PENDING")
                || sessionBookings!.find((b: any) => b.status === "CANCELLED")
                || sessionBookings![0])
              : null;
            type TimelineItem = { type: "message"; msg: ChatMessage; ts: string } | { type: "booking"; booking: any; ts: string };
            const msgItems: TimelineItem[] = messages.map((m) => ({ type: "message" as const, msg: m, ts: m.createdAt || "" }));
            const bookingItems: TimelineItem[] = activeBooking
              ? [{ type: "booking" as const, booking: activeBooking, ts: activeBooking.createdAt || activeBooking.scheduledAt || "" }]
              : [];
            const timeline = [...msgItems, ...bookingItems].sort(
              (a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime()
            );
            return timeline.map((item, idx) => {
              if (item.type === "booking") {
                return (
                  <div key={`booking-${item.booking.id}`} className="px-1 pb-2" data-testid="parent-standalone-booking-card">
                    <div
                      className="w-full overflow-hidden border border-border bg-card"
                      style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
                    >
                      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
                        <div className="flex items-center gap-2 px-3 py-1.5">
                          <CalendarCheck className="w-4 h-4 text-white" />
                          <span className="text-white text-xs font-semibold uppercase tracking-wider">
                            {item.booking.status === "CANCELLED" ? "Meeting Cancelled" : "Meeting Scheduled"}
                          </span>
                        </div>
                      </div>
                      <div className="px-4 pb-4">
                        <InlineBookingCalendar
                          slug={sessionCalendarSlug?.slug || "__none__"}
                          memberName={sessionCalendarSlug?.memberName || item.booking.providerUser?.name || "Provider"}
                          brandColor={brandColor}
                          existingBooking={item.booking}
                        />
                      </div>
                    </div>
                  </div>
                );
              }
              const msg = item.msg;
              const i = messages.indexOf(msg);
              return (
            <div key={i}>
              {msg.createdAt && (() => {
                const msgDate = new Date(msg.createdAt).toDateString();
                const prevMsgItem = timeline.slice(0, idx).reverse().find((x) => x.type === "message");
                const prevDate = prevMsgItem ? new Date(prevMsgItem.ts).toDateString() : null;
                if (!prevDate || msgDate !== prevDate) {
                  return (
                    <div className="flex items-center justify-center my-3">
                      <span className="px-3 py-1 text-[11px] font-medium text-muted-foreground bg-muted/60 rounded-full shadow-sm">
                        {chatDateLabel(msg.createdAt)}
                      </span>
                    </div>
                  );
                }
                return null;
              })()}
              {(() => {
                const isOwnMessage = msg.role === "user" && (!msg.senderName || msg.senderName === myDisplayName);
                const isOtherParent = msg.role === "user" && msg.senderName && msg.senderName !== myDisplayName;
                const nameLabel = isOwnMessage
                  ? (myDisplayName || "You")
                  : isOtherParent
                  ? (msg.senderName || "Partner")
                  : msg.role === "user"
                  ? (msg.senderName || myDisplayName || "You")
                  : msg.senderType === "human"
                  ? (msg.senderName || "GoStork Expert")
                  : msg.senderType === "provider"
                  ? (msg.senderName || "Agency Expert")
                  : msg.senderType === "system"
                  ? (selectedMatchmaker?.name || "Eva")
                  : (selectedMatchmaker?.name || "AI");
                const alignRight = isOwnMessage || (!isOtherParent && msg.role === "user");
                return (
                  <>
                    {!alignRight && msg.matchCards && msg.matchCards.length > 0 && (
                      <div className="flex justify-start mb-2 ml-0">
                        <div className="space-y-3">
                          {msg.matchCards.map((card, ci) => (
                            <MatchCardComponent
                              key={ci}
                              card={card}
                              brandColor={brandColor}
                              onAction={handleQuickReply}
                              onViewProfile={handleViewProfile}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {!alignRight && (
                      <div className="flex justify-start mb-0.5">
                        <span className="text-[11px] font-medium text-muted-foreground" data-testid={`name-label-${i}`}>
                          {nameLabel}
                        </span>
                      </div>
                    )}
                    <div
                      className={`flex ${alignRight ? "justify-end" : "justify-start"}`}
                      data-testid={`chat-message-${msg.role}-${i}`}
                    >
                      <div
                        className={`max-w-[80%] px-4 py-2.5 text-base leading-relaxed font-ui ${
                          isOwnMessage
                            ? "text-white chat-bubble-dark"
                            : isOtherParent
                            ? "text-foreground"
                            : msg.role === "user"
                            ? "text-white chat-bubble-dark"
                            : "text-foreground"
                        }`}
                        style={{
                          borderRadius: `${brand?.borderRadius ?? 1}rem`,
                          ...(isOwnMessage
                            ? { backgroundColor: brandColor }
                            : isOtherParent
                            ? {
                                backgroundColor: chatPalette.partnerBg,
                                border: `1px solid ${chatPalette.partnerBorder}`,
                              }
                            : msg.role === "user"
                            ? { backgroundColor: brandColor }
                            : msg.senderType === "human"
                            ? {
                                backgroundColor: `${brandColor}14`,
                                border: `1px solid ${brandColor}33`,
                              }
                            : msg.senderType === "provider"
                            ? {
                                backgroundColor: chatPalette.expertBg,
                                border: `1px solid ${chatPalette.expertBorder}`,
                              }
                            : {
                                backgroundColor: `${brandColor}14`,
                                border: `1px solid ${brandColor}33`,
                              }),
                        }}
                      >
                        <span>{msg.content}</span>
                        {msg.createdAt && (
                          <span
                            className="inline-block align-bottom ml-2 whitespace-nowrap select-none"
                            style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55, verticalAlign: "bottom", position: "relative", top: "3px" }}
                          >
                            {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}

              {msg.prepDoc && (
                <div className="flex justify-start mt-3 ml-0">
                  <PrepDocCard brandColor={brandColor} />
                </div>
              )}

              {msg.consultationCard && (
                <div className="flex justify-start mt-3 ml-0">
                  <ConsultationBookingCard
                    card={msg.consultationCard}
                    brandColor={brandColor}
                    onSchedule={(c) => setBookingCard(c)}
                    existingBooking={(() => {
                      if (!sessionBookings) return undefined;
                      const providerBookings = sessionBookings.filter(
                        (b: any) => b.providerUser?.provider?.id === msg.consultationCard?.providerId
                      );
                      return providerBookings.find((b: any) => b.status === "CONFIRMED")
                        || providerBookings.find((b: any) => b.status === "PENDING")
                        || providerBookings.find((b: any) => b.status === "CANCELLED")
                        || providerBookings[0];
                    })()}
                  />
                </div>
              )}

              {msg.uiCardType && msg.uiCardData && (
                <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} mt-2`}>
                  <div className="max-w-[75%]">
                    <ConciergeSpecialCard msg={msg} brandColor={brandColor} onOpenInlineVideo={setInlineVideoBookingId} />
                  </div>
                </div>
              )}

              {msg.quickReplies && msg.quickReplies.length > 0 && i === messages.length - 1 && (
                <div className="flex flex-wrap gap-2 mt-2 ml-0" data-testid="quick-replies">
                  {msg.quickReplies.map((qr, qi) => {
                    const isMulti = msg.multiSelect;
                    const isSelected = isMulti && multiSelectChoices.has(qr);
                    return (
                      <Button
                        key={qi}
                        variant="outline"
                        size="sm"
                        className="text-sm transition-all hover:shadow-sm"
                        style={{
                          borderRadius: "999px",
                          borderColor: isSelected ? brandColor : `${brandColor}40`,
                          backgroundColor: isSelected ? `${brandColor}15` : "transparent",
                          color: brandColor,
                        }}
                        onClick={() => {
                          if (isMulti) {
                            setMultiSelectChoices((prev) => {
                              const next = new Set(prev);
                              if (next.has(qr)) {
                                next.delete(qr);
                              } else {
                                next.add(qr);
                              }
                              return next;
                            });
                          } else {
                            handleQuickReply(qr);
                          }
                        }}
                        disabled={sending}
                        data-testid={`quick-reply-${qi}`}
                      >
                        {isSelected && <span className="mr-1">✓</span>}
                        {qr}
                      </Button>
                    );
                  })}
                  {msg.multiSelect && multiSelectChoices.size > 0 && (
                    <Button
                      size="sm"
                      className="text-sm font-medium"
                      style={{
                        borderRadius: "999px",
                        backgroundColor: brandColor,
                        color: "white",
                      }}
                      onClick={() => {
                        const selected = Array.from(multiSelectChoices).join(", ");
                        setMultiSelectChoices(new Set());
                        handleQuickReply(selected);
                      }}
                      disabled={sending}
                      data-testid="multi-select-done"
                    >
                      Done
                    </Button>
                  )}
                </div>
              )}
            </div>
              );
            })
          })()}
          {sending && (
            <div className="flex items-center gap-2 justify-start py-1" data-testid="chat-typing-indicator">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-xs text-muted-foreground">{selectedMatchmaker?.name || "AI Concierge"} is typing</span>
            </div>
          )}
          {(externalBookingSlug || conciergeBookingSlug) && (() => {
            const bk = externalBookingSlug || conciergeBookingSlug!;
            const onClose = externalBookingSlug ? onCloseExternalBooking : () => setConciergeBookingSlug(null);
            return (
              <div className="px-1 pb-2">
                <div
                  className="w-full overflow-hidden border border-border bg-card"
                  style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
                  data-testid="parent-meeting-booking-card"
                >
                  <div className="p-1.5" style={{ backgroundColor: brandColor }}>
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <CalendarCheck className="w-4 h-4 text-white" />
                      <span className="text-white text-xs font-semibold uppercase tracking-wider">Schedule a Meeting</span>
                    </div>
                  </div>
                  <div className="px-4 pb-4">
                    <InlineBookingCalendar
                      slug={bk.slug}
                      memberName={bk.memberName}
                      brandColor={brandColor}
                    />
                  </div>
                </div>
              </div>
            );
          })()}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t px-4 py-3" data-testid="concierge-input-area">
          <div className="flex items-center gap-2">
            <input
              ref={parentFileInputRef}
              type="file"
              className="hidden"
              accept="image/*,application/pdf,.doc,.docx,.txt"
              onChange={handleParentFileSelect}
              data-testid="input-parent-file"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 p-0 shrink-0 rounded-full"
              style={{ color: brandColor }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={() => parentFileInputRef.current?.click()}
              disabled={parentUploading}
              data-testid="btn-attach"
            >
              {parentUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </Button>
            <Input
              placeholder={`Message ${providerInChat && providerChatName ? providerChatName : (selectedMatchmaker?.name || "AI Concierge")}...`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              className="flex-1 !text-base font-ui rounded-full"
              data-testid="input-concierge-message"
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="h-10 w-10 p-0 rounded-full text-white shrink-0"
              style={{ backgroundColor: brandColor }}
              data-testid="btn-send-message"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
        
      </div>
      {bookingCard && (
        <BookingOverlay
          card={bookingCard}
          brandColor={brandColor}
          userEmail={(user as any)?.email || ""}
          userName={(user as any)?.name || ""}
          onClose={() => setBookingCard(null)}
        />
      )}
      {inlineVideoBookingId && (
        <ConciergeInlineVideoOverlay
          bookingId={inlineVideoBookingId}
          onClose={() => setInlineVideoBookingId(null)}
        />
      )}
    </>
  );
}
