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
import { Loader2, Send, ArrowLeft, Sparkles, Headphones, FileText, Download, Heart, Brain, Stethoscope, MessageCircle, Shield, CalendarCheck, CalendarDays, X, ExternalLink, ChevronLeft, ChevronRight, Clock, Video, Globe, Check, Paperclip } from "lucide-react";
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

function InlineBookingCalendar({
  slug,
  memberName,
  brandColor,
}: {
  slug: string;
  memberName: string;
  brandColor: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [step, setStep] = useState<"date" | "form" | "pending">("date");
  const [name, setName] = useState(user ? (user as any).name || "" : "");
  const [email, setEmail] = useState(user ? (user as any).email || "" : "");
  const [phone, setPhone] = useState(user ? (user as any).mobileNumber || "" : "");
  const [notes, setNotes] = useState("");
  const [booking, setBooking] = useState<any>(null);

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
      const res = await apiRequest("POST", `/api/calendar/book/${slug}`, {
        scheduledAt,
        name,
        email,
        phone: phone || null,
        notes: notes || null,
        timezone: bookerTimezone,
      });
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
      <div className="space-y-4 py-3" data-testid="inline-booking-pending">
        <div className="text-center space-y-1">
          <div className="w-12 h-12 mx-auto rounded-full bg-[hsl(var(--brand-warning,40_96%_53%)/0.12)] flex items-center justify-center">
            <Clock className="w-6 h-6 text-[hsl(var(--brand-warning,40_96%_53%))]" />
          </div>
          <p className="font-bold text-sm">Awaiting Confirmation</p>
          <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning,40_96%_53%)/0.12)] text-[hsl(var(--brand-warning,40_96%_53%))]">
            Pending
          </span>
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

        <div className="bg-[hsl(var(--brand-warning,40_96%_53%)/0.08)] border border-[hsl(var(--brand-warning,40_96%_53%)/0.3)] rounded-xl p-3">
          <p className="text-xs font-medium text-[hsl(var(--brand-warning,40_96%_53%))]">Awaiting provider confirmation</p>
          <p className="text-[11px] text-[hsl(var(--brand-warning,40_96%_53%))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
        </div>

        {booking.publicToken && (
          <div className="flex gap-2">
            <a
              href={`/booking/${booking.publicToken}`}
              className="flex-1 text-center text-xs font-medium py-2 rounded-lg border border-border hover:bg-muted transition-colors"
              data-testid="link-reschedule-inline"
            >
              Reschedule
            </a>
            <a
              href={`/booking/${booking.publicToken}`}
              className="flex-1 text-center text-xs font-medium py-2 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/5 transition-colors"
              data-testid="link-cancel-inline"
            >
              Cancel
            </a>
          </div>
        )}
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
}: {
  card: ConsultationCardData;
  brandColor: string;
  onSchedule: (card: ConsultationCardData) => void;
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
            <span className="text-white text-xs font-semibold uppercase tracking-wider">Schedule a Free Consultation</span>
          </div>
        </div>
        <div className="px-4 pb-4">
          <InlineBookingCalendar
            slug={card.memberBookingSlug}
            memberName={card.memberName || card.providerName}
            brandColor={brandColor}
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
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
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

function ConciergeSpecialCard({ msg, brandColor }: { msg: ChatMessage; brandColor: string }) {
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
    return (
      <a
        href={data.roomUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-background hover:bg-muted transition-colors"
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
        <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
      </a>
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
}

export default function ConciergeChatPage({ inlineSessionId, inlineMatchmakerId, isInline }: ConciergeChatProps = {}) {
  const [searchParams] = useSearchParams();
  const matchmakerId = isInline ? (inlineMatchmakerId || null) : searchParams.get("matchmaker");
  const existingSessionId = isInline ? (inlineSessionId || null) : searchParams.get("session");
  const isEmbedded = isInline || searchParams.get("embedded") === "1";
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
      } else {
        alert("This provider hasn't set up online scheduling yet. You can message them to arrange a meeting.");
      }
    } catch {
      alert("Failed to load calendar. Please try again.");
    }
  }, [sessionId]);

  const handleConciergeVideo = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch("/api/video/room", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const { url: roomUrl } = await res.json();
      await fetch(`/api/chat-session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          content: "I've started a video call — join when you're ready!",
          uiCardType: "video_invite",
          uiCardData: { roomUrl },
        }),
      });
      window.open(roomUrl, "_blank");
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
  const effectiveMatchmakerId = matchmakerId || resolvedMatchmakerId;
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
        const sessRes = await fetch("/api/my/chat-sessions", { credentials: "include" });
        if (sessRes.ok) {
          const sessions = await sessRes.json();
          const conciergeSession = sessions[0];
          if (conciergeSession) {
            setSessionId(conciergeSession.id);
            if (matchmakerId && conciergeSession.matchmakerId !== matchmakerId) {
              await fetch("/api/my/chat-session/matchmaker", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ matchmakerId }),
              });
              setResolvedMatchmakerId(matchmakerId);
            } else if (conciergeSession.matchmakerId) {
              setResolvedMatchmakerId(conciergeSession.matchmakerId);
            }
            await loadMessagesForSession(conciergeSession.id);
          }
        }
      } catch {}
      setSessionLoaded(true);
    })();
  }, [existingSessionId, matchmakerId, sessionLoaded]);

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
    if (greetingSet || !selectedMatchmaker || !user || !profileReady) return;
    if (!sessionLoaded) return;
    if (sessionId || existingSessionId) return;
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
    setMessages([{ role: "assistant", content: greeting }]);
    setGreetingSet(true);

    (async () => {
      try {
        const res = await fetch("/api/ai-concierge/init-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ matchmakerId: effectiveMatchmakerId, greeting }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.sessionId) setSessionId(data.sessionId);
          if (data.greetingMessageId) knownMessageIds.current.add(data.greetingMessageId);
        }
      } catch {}
    })();
  }, [selectedMatchmaker, user, profileReady, greetingSet, parentProfileQuery.data, sessionLoaded, sessionId, existingSessionId]);

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
      return [...updated, { role: "user" as const, content: userMessage }];
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

      if (data.userMessageId) knownMessageIds.current.add(data.userMessageId);
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
        { role: "assistant", content: "I'm sorry, I'm having trouble connecting right now. Please try again." },
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
            {sessionTitle && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 gap-1.5 font-ui text-xs"
                  style={{ color: brandColor }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  onClick={handleConciergeMeeting}
                  data-testid="btn-meeting"
                >
                  <CalendarDays className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Meeting</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 gap-1.5 font-ui text-xs"
                  style={{ color: brandColor }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  onClick={handleConciergeVideo}
                  data-testid="btn-video"
                >
                  <Video className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Video</span>
                </Button>
              </>
            )}
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
          </div>
        </div>}

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" data-testid="concierge-messages">
          {messages.map((msg, i) => (
            <div key={i}>
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
                        {msg.content}
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

              {msg.matchCards && msg.matchCards.length > 0 && (
                <div className="flex justify-start mt-3 ml-0">
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

              {msg.consultationCard && (
                <div className="flex justify-start mt-3 ml-0">
                  <ConsultationBookingCard
                    card={msg.consultationCard}
                    brandColor={brandColor}
                    onSchedule={(c) => setBookingCard(c)}
                  />
                </div>
              )}

              {msg.uiCardType && msg.uiCardData && (
                <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} mt-2`}>
                  <div className="max-w-[75%]">
                    <ConciergeSpecialCard msg={msg} brandColor={brandColor} />
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
          ))}
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
      {conciergeBookingSlug && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background" data-testid="concierge-booking-overlay">
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ backgroundColor: `${brandColor}08` }}>
            <div className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5" style={{ color: brandColor }} />
              <span className="font-semibold text-sm">Book with {conciergeBookingSlug.memberName}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setConciergeBookingSlug(null)} data-testid="btn-close-concierge-booking">
              <X className="w-5 h-5" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto">
            <iframe
              src={`${window.location.origin}/book/${conciergeBookingSlug.slug}`}
              className="w-full h-full border-0"
              title="Book a meeting"
            />
          </div>
        </div>
      )}
    </>
  );
}
