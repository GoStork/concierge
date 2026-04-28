import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { deriveChatPalette } from "@/lib/chat-palette";
import { getPhotoSrc } from "@/lib/profile-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { MessageStatus } from "@/components/ui/message-status";
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
  buildSidebarSections,
  type SidebarSection,
} from "@/components/marketplace/swipe-mappers";
import { Loader2, Send, ArrowLeft, Sparkles, Headphones, FileText, Download, Heart, Brain, Stethoscope, MessageCircle, Shield, CalendarCheck, CalendarDays, X, ExternalLink, ChevronLeft, ChevronRight, Clock, Video, Globe, Check, Paperclip, UserPlus, Plus, Maximize, Minimize, PenLine, User, CheckCircle2 } from "lucide-react";
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
  eggSource?: string;
  ageGroup?: string;
  isNewPatient?: boolean;
}

export interface ConsultationCardData {
  providerId: string;
  providerName: string;
  providerLogo?: string;
  bookingUrl?: string;
  iframeEnabled?: boolean;
  providerEmail?: string;
  memberBookingSlug?: string;
  memberName?: string;
  memberPhoto?: string;
  aiSessionId?: string;
  matchmakerId?: string | null;
  profileLabel?: string | null;
  profilePhotoUrl?: string | null;
  subjectProfileId?: string | null;
  subjectType?: string | null;
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
  agreementCard?: { agreementId: string; status: string; viewUrl: string | null };
  senderType?: string;
  senderName?: string;
  uiCardType?: string;
  uiCardData?: any;
  deliveredAt?: string | null;
  readAt?: string | null;
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

// Phase 0 templates - static, bypass AI generation for consistency.
// Covers the marketplace overview only. The AI delivers the vetting paragraph
// and Phase 1 question after the parent answers the engagement question below.
const PHASE0_SURROGACY = `Before we dive in, let me give you a quick picture of how GoStork works.

GoStork is a fertility marketplace - think of us like Kayak or Expedia for fertility. Instead of researching dozens of agencies on your own, we've brought everything together in one place with full transparent pricing and no surprises. We partner with over 60 surrogacy agencies, and it's completely free for intended parents - the agencies pay us a referral fee and are not allowed to pass that cost on to you.

Where are you in your journey right now - just starting to explore, or have you already done some research?`;

const PHASE0_EGG_DONOR = `Before we dive in, let me give you a quick picture of how GoStork works.

GoStork is a fertility marketplace - think of us like Kayak or Expedia for fertility. Instead of searching across dozens of agency websites, we've pulled everything into one place with full transparent pricing. We work with 30 egg donor agencies and have over 10,000 egg donors in our database. And it's completely free for intended parents - the agencies pay us a referral fee and are not allowed to pass that cost on to you.

Where are you in your journey right now - just starting to explore, or have you already done some research?`;

const PHASE0_CLINIC = `Before we dive in, let me give you a quick picture of how GoStork works.

GoStork is a fertility marketplace - think of us like Kayak or Expedia for fertility. Instead of researching IVF clinics across dozens of websites, we've brought over 30 vetted clinics into one place with full transparent pricing. And it's completely free for intended parents - the clinics pay us a referral fee and are not allowed to pass that cost on to you.

Where are you in your journey right now - just starting to explore, or have you already done some research?`;

const PHASE0_GENERAL = `Before we dive in, let me give you a quick picture of how GoStork works.

GoStork is a fertility marketplace - think of us like Kayak or Expedia for fertility. Instead of researching providers across dozens of websites, we've brought everything together in one place with full transparent pricing. We partner with over 60 surrogacy agencies, 30 egg donor agencies with 10,000+ donors, and 30+ IVF clinics. And it's completely free for intended parents - providers pay us a referral fee and are not allowed to pass that cost on to you.

Where are you in your journey right now - just starting to explore, or have you already done some research?`;

function buildPhase0(services: string[]): string {
  if (services.includes("Surrogate")) return PHASE0_SURROGACY;
  if (services.includes("Egg Donor")) return PHASE0_EGG_DONOR;
  if (services.includes("Fertility Clinic")) return PHASE0_CLINIC;
  return PHASE0_GENERAL;
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
          <FileText className="w-4 h-4 text-primary-foreground" />
          <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">Match Call Prep Guide</span>
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
          Tip: Start warm and personal - this is a relationship-building moment, not just a checklist.
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

function AgreementSignCard({ card, brandColor, createdAt }: { card: { agreementId: string; status: string; viewUrl: string | null }; brandColor: string; createdAt?: string }) {
  const navigate = useNavigate();
  return (
    <Card
      className="overflow-hidden max-w-sm animate-[slideUp_0.4s_ease-out_forwards]"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <FileText className="w-4 h-4 text-primary-foreground" />
          <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">Agreement Ready to Sign</span>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Your agency agreement is ready. Review it carefully and sign electronically to move forward.
        </p>
        {card.agreementId ? (
          <button
            onClick={() => navigate(`/agreements/${card.agreementId}`)}
            className="flex items-center justify-center gap-2 w-full py-2 px-4 rounded-[var(--radius)] text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            style={{ backgroundColor: brandColor }}
          >
            <PenLine className="w-4 h-4" />
            Review &amp; Sign Agreement
          </button>
        ) : (
          <p className="text-xs text-muted-foreground italic">Check your email for the signing link.</p>
        )}
        {createdAt && (
          <div className="flex justify-end">
            <span style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }} className="whitespace-nowrap select-none">
              {new Date(createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
            </span>
          </div>
        )}
      </div>
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

export function RescheduleCalendarPicker({
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
                ${isSelected ? "text-primary-foreground font-bold" : ""}
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
        <RescheduleDateSlots
          selectedDate={selectedDate}
          slotsLoading={slotsLoading}
          availability={availability}
          selectedSlot={selectedSlot}
          brandColor={brandColor}
          onSelectSlot={setSelectedSlot}
        />
      )}
      {selectedSlot && (
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-[var(--radius)] border border-border hover:bg-muted transition-colors cursor-pointer"
            data-testid="btn-reschedule-cancel"
          >
            Cancel
          </button>
          <button
            onClick={handleReschedule}
            disabled={submitting}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-[var(--radius)] text-primary-foreground transition-colors cursor-pointer disabled:opacity-50"
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

function BookingForm({
  selectedDate, selectedSlot, name, setName, email, setEmail, phone, setPhone,
  notes, setNotes, additionalAttendees, showAttendeeFields, setShowAttendeeFields,
  newAttendeeEmail, setNewAttendeeEmail, newAttendeeName, setNewAttendeeName,
  newAttendeePhone, setNewAttendeePhone, addAttendee, removeAttendee,
  bookMutation, brandColor, onBack,
}: {
  selectedDate: Date; selectedSlot: string;
  name: string; setName: (v: string) => void;
  email: string; setEmail: (v: string) => void;
  phone: string; setPhone: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  additionalAttendees: { email: string; name: string; phone: string }[];
  showAttendeeFields: boolean; setShowAttendeeFields: (v: boolean) => void;
  newAttendeeEmail: string; setNewAttendeeEmail: (v: string) => void;
  newAttendeeName: string; setNewAttendeeName: (v: string) => void;
  newAttendeePhone: string; setNewAttendeePhone: (v: string) => void;
  addAttendee: () => void; removeAttendee: (email: string) => void;
  bookMutation: any; brandColor: string; onBack: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showNotes, setShowNotes] = useState(!!notes);

  // Scroll into view when the form mounts
  useEffect(() => {
    if (!ref.current) return;
    const t = setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div ref={ref} className="space-y-2 py-1">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        data-testid="button-back-to-dates-inline"
      >
        <ChevronLeft className="w-3 h-3" />
        Back
      </button>
      <div className="bg-muted/50 rounded-[var(--radius)] px-3 py-2 flex items-center gap-2 text-sm">
        <CalendarCheck className="w-4 h-4 text-primary shrink-0" />
        <span className="font-medium">{format(selectedDate, "EEE, MMM d")}</span>
        <span className="text-muted-foreground">at {formatTime12(selectedSlot)}</span>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); bookMutation.mutate(); }} className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <Label className="text-[11px] font-medium">Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required className="h-8 text-xs" data-testid="input-book-name-inline" />
          </div>
          <div className="space-y-0.5">
            <Label className="text-[11px] font-medium">Email *</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-8 text-xs" data-testid="input-book-email-inline" />
          </div>
        </div>
        <div className="space-y-0.5">
          <Label className="text-[11px] font-medium">Phone</Label>
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-8 text-xs" data-testid="input-book-phone-inline" />
        </div>

        <div className="space-y-1.5">
          {additionalAttendees.length > 0 && !showAttendeeFields && (
            <div className="space-y-1">
              {additionalAttendees.map((ae) => (
                <div key={ae.email} className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-[var(--radius)] px-2 py-1.5" data-testid={`attendee-chip-inline-${ae.email}`}>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{ae.name || ae.email}</p>
                    {ae.name && <p className="text-[11px] text-muted-foreground truncate">{ae.email}</p>}
                  </div>
                  <button type="button" onClick={() => removeAttendee(ae.email)} className="text-muted-foreground hover:text-destructive transition-colors shrink-0" data-testid={`button-remove-attendee-inline-${ae.email}`}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!showAttendeeFields ? (
            <button type="button" onClick={() => setShowAttendeeFields(true)} className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium" data-testid="button-show-attendee-fields-inline">
              <UserPlus className="w-3.5 h-3.5" />
              Add Additional Attendees
            </button>
          ) : (
            <div className="space-y-1.5 bg-muted/30 border border-border rounded-[var(--radius)] p-2.5">
              <Label className="flex items-center gap-1.5 text-[11px] font-medium"><UserPlus className="w-3 h-3" />Additional Attendees</Label>
              {additionalAttendees.length > 0 && (
                <div className="space-y-1">
                  {additionalAttendees.map((ae) => (
                    <div key={ae.email} className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-[var(--radius)] px-2 py-1.5" data-testid={`attendee-chip-inline-${ae.email}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{ae.name || ae.email}</p>
                        {ae.name && <p className="text-[11px] text-muted-foreground truncate">{ae.email}</p>}
                      </div>
                      <button type="button" onClick={() => removeAttendee(ae.email)} className="text-muted-foreground hover:text-destructive transition-colors shrink-0" data-testid={`button-remove-attendee-inline-${ae.email}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Input type="email" value={newAttendeeEmail} onChange={(e) => setNewAttendeeEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAttendee(); } }} placeholder="Email address *" className="h-7 text-xs" data-testid="input-additional-attendee-inline" />
              <div className="flex gap-1.5">
                <Input type="text" value={newAttendeeName} onChange={(e) => setNewAttendeeName(e.target.value)} placeholder="Name (optional)" className="h-7 text-xs flex-1" data-testid="input-additional-attendee-name-inline" />
                <Input type="tel" value={newAttendeePhone} onChange={(e) => setNewAttendeePhone(e.target.value)} placeholder="Phone (optional)" className="h-7 text-xs flex-1" data-testid="input-additional-attendee-phone-inline" />
              </div>
              <div className="flex gap-1.5">
                <Button type="button" variant="outline" size="sm" onClick={addAttendee} className="h-7 flex-1 gap-1 text-xs" disabled={!newAttendeeEmail.trim()} data-testid="button-add-attendee-inline"><Plus className="w-3 h-3" />Add</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAttendeeFields(false)} className="h-7 flex-1 text-[11px] text-muted-foreground" data-testid="button-close-attendee-fields-inline">Done</Button>
              </div>
            </div>
          )}
        </div>

        {!showNotes ? (
          <button type="button" onClick={() => setShowNotes(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <Plus className="w-3 h-3" />
            Add notes (optional)
          </button>
        ) : (
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-xs resize-none" placeholder="Anything you'd like to share..." data-testid="input-book-notes-inline" />
        )}

        {bookMutation.isError && (
          <p className="text-xs text-destructive">{(bookMutation.error as Error).message}</p>
        )}
        <Button
          type="submit"
          className="w-full h-9 text-sm font-semibold text-primary-foreground"
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

function RescheduleDateSlots({
  selectedDate,
  slotsLoading,
  availability,
  selectedSlot,
  brandColor,
  onSelectSlot,
}: {
  selectedDate: Date;
  slotsLoading: boolean;
  availability: any;
  selectedSlot: string | null;
  brandColor: string;
  onSelectSlot: (t: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const t = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => clearTimeout(t);
  }, [slotsLoading]);

  return (
    <div ref={ref} className="space-y-2">
      <p className="text-xs font-medium">{format(selectedDate, "EEE, MMM d")} - Select a time:</p>
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
                onClick={() => onSelectSlot(t)}
                className={`text-xs py-1.5 rounded-[var(--radius)] border transition-colors cursor-pointer ${isSel ? "text-primary-foreground border-transparent font-semibold" : "border-border hover:bg-muted"}`}
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
  );
}

export function InlineBookingCalendar({
  slug,
  memberName,
  brandColor,
  existingBooking: existingBookingProp,
  consultationMeta,
  autoResetOnCancel,
  showCalendarOnExpiry,
  onBookingConfirmed,
}: {
  slug: string;
  memberName: string;
  brandColor: string;
  existingBooking?: any;
  consultationMeta?: { aiSessionId?: string; matchmakerId?: string | null; profileLabel?: string | null; profilePhotoUrl?: string | null; providerId?: string; subjectProfileId?: string | null; subjectType?: string | null };
  autoResetOnCancel?: boolean;
  showCalendarOnExpiry?: boolean;
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null }) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const isCancelled = existingBookingProp?.status === "CANCELLED";
  const [step, setStep] = useState<"date" | "form" | "pending" | "reschedule" | "cancel_confirm" | "cancelled">(
    existingBookingProp
      ? (isCancelled ? (autoResetOnCancel ? "date" : "cancelled") : "pending")
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
          setStep(autoResetOnCancel ? "date" : "cancelled");
        } else {
          setStep("pending");
        }
        prevBookingRef.current = { id: existingBookingProp.id, status: existingBookingProp.status };
      }
    }
  }, [existingBookingProp]);

  // Poll the booking directly when in "pending" step so confirmation by GoStork admin
  // (or any provider) is reflected immediately without waiting for sessionBookings to catch up.
  const { data: polledBooking } = useQuery({
    queryKey: ["/api/calendar/bookings", booking?.id, "status-poll"],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/bookings/${booking!.id}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: step === "pending" && !!booking?.id && booking?.status !== "CONFIRMED",
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (polledBooking && polledBooking.status && polledBooking.status !== booking?.status) {
      setBooking(polledBooking);
      prevBookingRef.current = { id: polledBooking.id, status: polledBooking.status };
    }
  }, [polledBooking]);

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
      if (consultationMeta?.aiSessionId) {
        body.aiSessionId = consultationMeta.aiSessionId;
        body.consultationProviderId = consultationMeta.providerId;
        body.matchmakerId = consultationMeta.matchmakerId;
        body.profileLabel = consultationMeta.profileLabel;
        body.profilePhotoUrl = consultationMeta.profilePhotoUrl;
        body.subjectProfileId = consultationMeta.subjectProfileId;
        body.subjectType = consultationMeta.subjectType;
      }
      const res = await apiRequest("POST", `/api/calendar/book/${slug}`, body);
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.publicToken) {
        setBooking(data);
        setStep("pending");
        queryClient.invalidateQueries({ queryKey: ["/api/chat-session"] });
        queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
        onBookingConfirmed?.({ providerId: consultationMeta?.providerId, subjectProfileId: consultationMeta?.subjectProfileId });
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

  const bookingEnd = booking ? new Date(new Date(booking.scheduledAt).getTime() + (booking.duration || pageInfo?.meetingDuration || 30) * 60 * 1000) : null;
  const bookingHasPassed = bookingEnd ? new Date() > bookingEnd : false;
  const _bParentJoined = !!booking?.parentJoinedMeetingAt;
  const _bProviderJoined = !!booking?.providerJoinedMeetingAt;
  const bookingWasCompleted = bookingHasPassed && booking?.status === "CONFIRMED" && _bParentJoined && _bProviderJoined;
  const bookingIsParentNoShow = bookingHasPassed && booking?.status === "CONFIRMED" && _bProviderJoined && !_bParentJoined;
  const bookingIsProviderNoShow = bookingHasPassed && booking?.status === "CONFIRMED" && _bParentJoined && !_bProviderJoined;
  const bookingIsNoShow = bookingHasPassed && !bookingWasCompleted && !bookingIsParentNoShow && !bookingIsProviderNoShow && booking?.status !== "CANCELLED" && booking?.status !== "RESCHEDULED";

  const _bookingExpired = bookingWasCompleted || bookingIsParentNoShow || bookingIsProviderNoShow || bookingIsNoShow;
  if (step === "pending" && booking && (!bookingHasPassed || booking.status === "CANCELLED" || !(showCalendarOnExpiry && _bookingExpired))) {
    const start = new Date(booking.scheduledAt);
    const hasPassed = bookingHasPassed;
    const wasCompleted = bookingWasCompleted;
    const isParentNoShow = bookingIsParentNoShow;
    const isProviderNoShow = bookingIsProviderNoShow;
    const isNoShow = bookingIsNoShow;
    const isConfirmed = booking.status === "CONFIRMED";
    const isCancelledStatus = booking.status === "CANCELLED";
    const isParentCancelled = isCancelledStatus && booking.cancelledByRole === "parent";
    const isProviderCancelled = isCancelledStatus && booking.cancelledByRole === "provider";
    const providerUser = booking.providerUser;
    const providerPhotoSrc = getPhotoSrc(providerUser?.photoUrl);
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
      <div className="space-y-4 py-3" data-testid={isConfirmed ? "inline-booking-confirmed" : "inline-booking-pending"}>
        <div className="text-center space-y-1">
          {isParentCancelled ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                <X className="w-6 h-6 text-destructive" />
              </div>
              <p className="font-bold text-sm">Parent Cancelled</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                Parent Cancelled
              </span>
            </>
          ) : isProviderCancelled ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                <X className="w-6 h-6 text-destructive" />
              </div>
              <p className="font-bold text-sm">Provider Cancelled</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                Provider Cancelled
              </span>
            </>
          ) : isCancelledStatus ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                <X className="w-6 h-6 text-destructive" />
              </div>
              <p className="font-bold text-sm">Meeting Cancelled</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                Cancelled
              </span>
            </>
          ) : wasCompleted ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Check className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="font-bold text-sm">Meeting Completed</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Completed
              </span>
            </>
          ) : isParentNoShow ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Clock className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="font-bold text-sm">Parent No Show</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Parent No Show
              </span>
            </>
          ) : isProviderNoShow ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Clock className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="font-bold text-sm">Provider No Show</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Provider No Show
              </span>
            </>
          ) : isNoShow ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Clock className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="font-bold text-sm">No Show</p>
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                No Show
              </span>
            </>
          ) : isConfirmed ? (
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

        <div className="bg-muted/40 rounded-[var(--radius)] p-3 space-y-2.5 border border-border">
          <div className="flex items-center gap-3">
            {providerPhotoSrc ? (
              <img src={providerPhotoSrc} alt={providerName} className="w-12 h-12 rounded-full object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
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
          <div className="bg-muted/40 rounded-[var(--radius)] p-3 border border-border">
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

        {isParentCancelled ? (
          <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-destructive">Parent cancelled</p>
            <p className="text-[11px] text-destructive/80 mt-0.5">This meeting was cancelled by the parent.</p>
          </div>
        ) : isProviderCancelled ? (
          <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-destructive">Provider cancelled</p>
            <p className="text-[11px] text-destructive/80 mt-0.5">This meeting was cancelled by the provider.</p>
          </div>
        ) : isCancelledStatus ? (
          <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-destructive">Meeting cancelled</p>
            <p className="text-[11px] text-destructive/80 mt-0.5">This meeting has been cancelled.</p>
          </div>
        ) : wasCompleted ? (
          <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-muted-foreground">Meeting completed</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Both parties joined this consultation with {providerName}.</p>
          </div>
        ) : isParentNoShow ? (
          <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-muted-foreground">Parent no show</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">The provider joined the meeting room but the parent did not.</p>
          </div>
        ) : isProviderNoShow ? (
          <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-muted-foreground">Provider no show</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">The parent joined the meeting room but the provider did not.</p>
          </div>
        ) : isNoShow ? (
          <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-muted-foreground">No show</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">The scheduled time has passed and no one joined the meeting room.</p>
          </div>
        ) : isConfirmed ? (
          <div className="bg-[hsl(var(--brand-success,142_71%_45%)/0.08)] border border-[hsl(var(--brand-success,142_71%_45%)/0.3)] rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-[hsl(var(--brand-success,142_71%_45%))]">Meeting confirmed</p>
            <p className="text-[11px] text-[hsl(var(--brand-success,142_71%_45%))] mt-0.5">Your consultation with {providerName} is confirmed. You'll receive a reminder before the meeting.</p>
          </div>
        ) : (
          <div className="bg-[hsl(var(--brand-warning,40_96%_53%)/0.08)] border border-[hsl(var(--brand-warning,40_96%_53%)/0.3)] rounded-[var(--radius)] p-3">
            <p className="text-xs font-medium text-[hsl(var(--brand-warning,40_96%_53%))]">Awaiting provider confirmation</p>
            <p className="text-[11px] text-[hsl(var(--brand-warning,40_96%_53%))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
          </div>
        )}

        {booking.publicToken && !wasCompleted && !isNoShow && !isParentNoShow && !isProviderNoShow && !isCancelledStatus && (
          <div className="flex gap-2">
            <button
              onClick={() => { setSelectedDate(null); setSelectedSlot(null); setCurrentMonth(new Date()); setStep("reschedule"); }}
              className="flex-1 text-center text-xs font-medium py-2 rounded-[var(--radius)] border border-border hover:bg-muted transition-colors cursor-pointer"
              data-testid="btn-reschedule-inline"
            >
              Reschedule
            </button>
            <button
              onClick={() => setStep("cancel_confirm")}
              className="flex-1 text-center text-xs font-medium py-2 rounded-[var(--radius)] border border-destructive/30 text-destructive hover:bg-destructive/5 transition-colors cursor-pointer"
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
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-[var(--radius)] border border-border hover:bg-muted transition-colors cursor-pointer"
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
                  queryClient.invalidateQueries({ queryKey: ["/api/chat-session"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
                }
              } catch {} finally { setCancelling(false); }
            }}
            disabled={cancelling}
            className="flex-1 text-center text-xs font-medium py-2.5 rounded-[var(--radius)] bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50"
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
          className="w-full text-center text-xs font-semibold py-2.5 rounded-[var(--radius)] text-primary-foreground transition-colors cursor-pointer hover:opacity-90"
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
      <BookingForm
        selectedDate={selectedDate}
        selectedSlot={selectedSlot}
        name={name}
        setName={setName}
        email={email}
        setEmail={setEmail}
        phone={phone}
        setPhone={setPhone}
        notes={notes}
        setNotes={setNotes}
        additionalAttendees={additionalAttendees}
        showAttendeeFields={showAttendeeFields}
        setShowAttendeeFields={setShowAttendeeFields}
        newAttendeeEmail={newAttendeeEmail}
        setNewAttendeeEmail={setNewAttendeeEmail}
        newAttendeeName={newAttendeeName}
        setNewAttendeeName={setNewAttendeeName}
        newAttendeePhone={newAttendeePhone}
        setNewAttendeePhone={setNewAttendeePhone}
        addAttendee={addAttendee}
        removeAttendee={removeAttendee}
        bookMutation={bookMutation}
        brandColor={brandColor}
        onBack={() => setStep("date")}
      />
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
        <SelectedDateSlots
          selectedDate={selectedDate}
          slotsLoading={slotsLoading}
          availability={availability}
          onSelectSlot={(time) => { setSelectedSlot(time); setStep("form"); }}
        />
      )}
    </div>
  );
}

function SelectedDateSlots({
  selectedDate,
  slotsLoading,
  availability,
  onSelectSlot,
}: {
  selectedDate: Date;
  slotsLoading: boolean;
  availability: any;
  onSelectSlot: (time: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Scroll into view when date is selected or slots finish loading
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    // Use a short delay so layout has settled before scrolling
    const t = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => clearTimeout(t);
  }, [slotsLoading]);

  return (
    <div ref={ref} className="space-y-2">
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
              onClick={() => onSelectSlot(slot.time)}
              className="px-2 py-2 rounded-[var(--radius)] text-xs font-medium transition-all cursor-pointer bg-muted/50 border border-border hover:bg-primary/10 hover:border-primary/40 text-foreground/80"
              data-testid={`slot-inline-${slot.time}`}
            >
              {formatTime12(slot.time)}
            </button>
          ))}
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
  userEmail,
  userName,
  onCallbackSubmitted,
  onBookingConfirmed,
}: {
  card: ConsultationCardData;
  brandColor: string;
  onSchedule: (card: ConsultationCardData) => void;
  existingBooking?: any;
  userEmail?: string;
  userName?: string;
  onCallbackSubmitted?: () => void;
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null }) => void;
}) {
  const [callbackExpanded, setCallbackExpanded] = useState(false);
  const [callbackName, setCallbackName] = useState(userName || "");
  const [callbackEmail, setCallbackEmail] = useState(userEmail || "");
  const [callbackMessage, setCallbackMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [callbackError, setCallbackError] = useState("");

  async function handleCallbackSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setCallbackError("");
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
          aiSessionId: card.aiSessionId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: "Request failed" }));
        setCallbackError(data.message || "Something went wrong. Please try again.");
        return;
      }
      setSubmitted(true);
      onCallbackSubmitted?.();
    } catch {
      setCallbackError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (card.memberBookingSlug) {
    return (
      <div
        className="w-full animate-[slideUp_0.4s_ease-out_forwards] overflow-hidden border border-border bg-card"
        style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 540px)" }}
        data-testid="consultation-booking-card"
      >
        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <CalendarCheck className="w-4 h-4 text-primary-foreground" />
            <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
              {existingBooking && existingBooking.status !== "CANCELLED"
                ? card.providerName === "GoStork"
                  ? `GoStork Concierge Call with ${card.memberName || "GoStork Team"}`
                  : `Meeting with ${card.memberName || card.providerName || "Consultant"}`
                : card.providerName === "GoStork"
                  ? `Schedule GoStork Concierge Call with ${card.memberName || "GoStork Team"}`
                  : `Schedule with ${card.memberName || card.providerName || "Consultant"}`}
            </span>
          </div>
        </div>
        <div className="px-4 pb-4">
          <InlineBookingCalendar
            slug={card.memberBookingSlug}
            memberName={card.memberName || card.providerName}
            brandColor={brandColor}
            existingBooking={existingBooking}
            consultationMeta={{ aiSessionId: card.aiSessionId, matchmakerId: card.matchmakerId, profileLabel: card.profileLabel, profilePhotoUrl: card.profilePhotoUrl, providerId: card.providerId, subjectProfileId: card.subjectProfileId, subjectType: card.subjectType }}
            onBookingConfirmed={onBookingConfirmed}
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
          <CalendarCheck className="w-4 h-4 text-primary-foreground" />
          <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">Book a Consultation</span>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          {card.providerLogo ? (
            <img
              src={getPhotoSrc(card.providerLogo)!}
              alt={card.providerName}
              className="w-12 h-12 rounded-full object-cover border-2"
              style={{ borderColor: `${brandColor}30` }}
            />
          ) : (
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-lg font-bold"
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
        {card.bookingUrl ? (
          <Button
            className="w-full gap-2 text-primary-foreground"
            style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
            onClick={() => onSchedule(card)}
            data-testid="btn-schedule-consultation"
          >
            <CalendarCheck className="w-4 h-4" />
            Schedule Consultation
          </Button>
        ) : submitted ? (
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: `${brandColor}15` }}>
              <CalendarCheck className="w-5 h-5" style={{ color: brandColor }} />
            </div>
            <p className="text-sm font-medium">Request Sent!</p>
            <p className="text-xs text-muted-foreground">
              {card.providerName} will reach out to schedule your consultation.
            </p>
          </div>
        ) : callbackExpanded ? (
          <form onSubmit={handleCallbackSubmit} className="space-y-3 mt-1">
            <div className="space-y-1.5">
              <Label className="text-xs">Your Name</Label>
              <Input
                value={callbackName}
                onChange={e => setCallbackName(e.target.value)}
                required
                data-testid="input-callback-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input
                type="email"
                value={callbackEmail}
                onChange={e => setCallbackEmail(e.target.value)}
                required
                data-testid="input-callback-email"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Message (optional)</Label>
              <Textarea
                value={callbackMessage}
                onChange={e => setCallbackMessage(e.target.value)}
                placeholder="Tell them a bit about what you're looking for..."
                rows={3}
                data-testid="input-callback-message"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setCallbackExpanded(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="flex-1 text-primary-foreground gap-1.5"
                style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
                disabled={submitting}
                data-testid="btn-submit-callback"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {submitting ? "Sending..." : "Request Callback"}
              </Button>
            </div>
            {callbackError && (
              <p className="text-xs text-destructive text-center">{callbackError}</p>
            )}
          </form>
        ) : (
          <Button
            className="w-full gap-2 text-primary-foreground"
            style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
            onClick={() => setCallbackExpanded(true)}
            data-testid="btn-schedule-consultation"
          >
            <CalendarCheck className="w-4 h-4" />
            Schedule Consultation
          </Button>
        )}
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
  onCallbackSubmitted,
}: {
  card: ConsultationCardData;
  brandColor: string;
  userEmail: string;
  userName: string;
  onClose: () => void;
  onCallbackSubmitted?: () => void;
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
          aiSessionId: card.aiSessionId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: "Request failed" }));
        setError(data.message || "Something went wrong. Please try again.");
        return;
      }
      onCallbackSubmitted?.();
      onClose();
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
            {useIframe ? `Book with ${card.providerName}` : `Request Callback - ${card.providerName}`}
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
              className="inline-flex items-center gap-2 px-6 py-3 text-primary-foreground text-sm font-medium transition-opacity hover:opacity-90"
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
              className="text-primary-foreground mt-2"
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
                className="w-full text-primary-foreground gap-2"
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
    : getDonorTabs(swipeProfile, [], t === "sperm donor");

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

function ClinicMatchCard({ card, brandColor, onAction, onViewProfile }: { card: MatchCard; brandColor: string; onAction: (text: string) => void; onViewProfile: (card: MatchCard) => void }) {
  const [provider, setProvider] = useState<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/providers/${card.providerId}`, { credentials: "include" });
        if (res.ok) setProvider(await res.json());
      } catch {}
    })();
  }, [card.providerId]);

  // Build provider URL with filter context from match card data (must be before early return)
  const providerUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (card.eggSource) params.set("eggSource", card.eggSource);
    if (card.ageGroup) params.set("ageGroup", card.ageGroup);
    if (card.isNewPatient !== undefined) params.set("isNewPatient", String(card.isNewPatient));
    const qs = params.toString();
    return `/providers/${card.providerId}${qs ? `?${qs}` : ""}`;
  }, [card.providerId, card.eggSource, card.ageGroup, card.isNewPatient]);

  if (!provider) {
    return (
      <div className="min-w-[320px] max-w-[420px] w-full rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Use parent context from AI match card data, fall back to marketplace defaults
  const cardEggSource = card.eggSource || "own_eggs";
  const cardAgeGroup = card.ageGroup || "under_35";
  const cardIsNew = card.isNewPatient !== undefined ? card.isNewPatient : true; // marketplace defaults to new patient
  const allRates = provider.ivfSuccessRates || [];

  // Select rate using same logic as providers.controller.ts
  let rates: any = null;
  if (cardEggSource === "donor") {
    rates = allRates.find((r: any) => r.profileType === "donor" && r.metricCode === "pct_transfers_live_births_donor");
  } else if (cardIsNew) {
    rates = allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === cardAgeGroup && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval")
      || allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === cardAgeGroup && r.metricCode === "pct_intended_retrievals_live_births");
  } else {
    rates = allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === cardAgeGroup && !r.isNewPatient && r.metricCode === "pct_intended_retrievals_live_births");
  }
  // Fallback to marketplace default
  if (!rates) {
    rates = allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === "under_35" && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval") || null;
  }
  const pct = rates ? Math.round(Number(rates.successRate) * 100) : null;
  const natAvg = rates ? Math.round(Number(rates.nationalAverage) * 100) : null;
  const isTop10 = rates?.top10pct === true;
  const location = provider.locations?.[0];
  const locationStr = location ? `${location.city || ""}${location.state ? `, ${location.state}` : ""}` : card.location;

  return (
    <div
      className="min-w-[320px] max-w-[420px] w-full animate-[slideUp_0.4s_ease-out_forwards] border border-border bg-card overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid={`match-card-${card.providerId}`}
      onClick={() => navigate(providerUrl, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } })}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          {provider.logoUrl ? (
            <img src={getPhotoSrc(provider.logoUrl) || undefined} alt="" className="w-10 h-10 rounded-[var(--radius)] object-contain border border-border/30 bg-background p-0.5 shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded-[var(--radius)] flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0" style={{ backgroundColor: brandColor }}>
              {(provider.name || "C").charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-heading text-foreground leading-tight">{provider.name}</h3>
            {locationStr && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                {locationStr}
              </p>
            )}
          </div>
          {isTop10 && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-destructive/10 text-destructive border border-destructive/30 shrink-0">
              Top 10%
            </span>
          )}
        </div>

        {pct !== null && (
          <div>
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span className="text-2xl font-heading text-foreground">{pct}%</span>
              <span className="text-sm text-muted-foreground">success rate</span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">{cardEggSource === "donor" ? "Donor eggs" : [
              "Own eggs",
              cardAgeGroup === "under_35" ? "Under 35" : cardAgeGroup === "35_37" ? "35-37" : cardAgeGroup === "38_40" ? "38-40" : "Over 40",
              cardIsNew ? "First-time IVF" : "Prior cycles",
            ].join(" · ")}</p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">This clinic</span>
                <span className="font-ui text-foreground">{pct}%</span>
              </div>
              <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: brandColor }} />
              </div>
              {natAvg !== null && natAvg > 0 && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">National average</span>
                    <span className="font-ui text-muted-foreground">{natAvg}%</span>
                  </div>
                  <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.min(natAvg, 100)}%` }} />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {card.reasons?.length > 0 && (
          <p className="text-xs text-muted-foreground">{card.reasons.join(" · ")}</p>
        )}
      </div>

      <div className="border-t border-border/50 px-4 py-3 flex gap-2">
        <Button variant="outline" className="flex-1 text-xs font-ui h-8" onClick={(e) => { e.stopPropagation(); navigate(providerUrl, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } }); }}>
          View Details
        </Button>
        <Button className="flex-1 text-xs font-ui h-8 text-primary-foreground" style={{ backgroundColor: brandColor }} onClick={(e) => { e.stopPropagation(); onAction(`I'd like to schedule a consultation with ${provider.name}`); }}>
          Schedule Consultation
        </Button>
      </div>
    </div>
  );
}

function AgencyMatchCard({ card, brandColor, onAction }: { card: MatchCard; brandColor: string; onAction: (text: string) => void }) {
  const [provider, setProvider] = useState<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/providers/${card.providerId}`, { credentials: "include" });
        if (res.ok) setProvider(await res.json());
      } catch {}
    })();
  }, [card.providerId]);

  if (!provider) {
    return (
      <div className="min-w-[320px] max-w-[420px] w-full rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const sp = provider.surrogacyProfile || {};
  const primaryLocation = provider.locations?.[0];
  const allLocations: string[] = (provider.locations || [])
    .map((l: any) => [l.city, l.state].filter(Boolean).join(", "))
    .filter(Boolean);
  const locationStr = card.location || allLocations[0] || "";

  const stats: { label: string; value: string }[] = [];
  if (sp.numberOfBabiesBorn) stats.push({ label: "Babies born", value: String(sp.numberOfBabiesBorn) + "+" });
  if (sp.timeToMatch) stats.push({ label: "Time to match", value: sp.timeToMatch });
  if (sp.familiesPerCoordinator) stats.push({ label: "Families / coordinator", value: String(sp.familiesPerCoordinator) });

  return (
    <div
      className="min-w-[320px] max-w-[420px] w-full animate-[slideUp_0.4s_ease-out_forwards] border border-border bg-card overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid={`match-card-${card.providerId}`}
      onClick={() => navigate(`/providers/${card.providerId}`, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } })}
    >
      <div className="p-4 space-y-3">
        {/* Header: logo + name + location */}
        <div className="flex items-start gap-3">
          {provider.logoUrl ? (
            <img src={getPhotoSrc(provider.logoUrl) || undefined} alt="" className="w-10 h-10 rounded-[var(--radius)] object-contain border border-border/30 bg-background p-0.5 shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded-[var(--radius)] flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0" style={{ backgroundColor: brandColor }}>
              {(provider.name || "A").charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-heading text-foreground leading-tight">{provider.name}</h3>
            {locationStr && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                {locationStr}
              </p>
            )}
          </div>
        </div>

        {/* Key stats */}
        {stats.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {stats.map((s) => (
              <div key={s.label} className="rounded-[var(--radius)] bg-muted px-2 py-2 text-center">
                <p className="text-sm font-heading text-foreground">{s.value}</p>
                <p className="text-xs text-muted-foreground leading-tight mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Match reasons */}
        {card.reasons?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {card.reasons.map((r) => (
              <span key={r} className="text-xs px-2 py-0.5 rounded-full border border-border bg-background text-foreground font-ui">
                {r}
              </span>
            ))}
          </div>
        )}

        {/* Additional locations */}
        {allLocations.length > 1 && (
          <p className="text-xs text-muted-foreground">
            Also in: {allLocations.slice(1).join(" · ")}
          </p>
        )}
      </div>

      <div className="border-t border-border/50 px-4 py-3 flex gap-2">
        <Button
          variant="outline"
          className="flex-1 text-xs font-ui h-8"
          onClick={(e) => { e.stopPropagation(); navigate(`/providers/${card.providerId}`, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } }); }}
        >
          View Agency
        </Button>
        <Button
          className="flex-1 text-xs font-ui h-8 text-primary-foreground"
          style={{ backgroundColor: brandColor }}
          onClick={(e) => { e.stopPropagation(); onAction(`I'd like to schedule a consultation with ${provider.name}`); }}
        >
          Book Consultation
        </Button>
      </div>
    </div>
  );
}

function MatchCardComponent({ card, brandColor, onAction, onViewProfile }: { card: MatchCard; brandColor: string; onAction: (text: string) => void; onViewProfile: (card: MatchCard) => void }) {
  const [profile, setProfile] = useState<any>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const cardType = card.type || "";
  const isClinic = cardType.toLowerCase() === "clinic";
  const isAgency = cardType.toLowerCase() === "surrogacyagency" || cardType.toLowerCase() === "surrogacy agency";

  useEffect(() => {
    if (isClinic || isAgency) return;
    const fetchProfile = async () => {
      try {
        const typeSlug = cardType.toLowerCase().replace(" ", "-");
        const res = await fetch(`/api/marketplace/profile/${typeSlug}/${card.providerId}`, { credentials: "include" });
        if (res.ok) {
          setProfile(await res.json());
        } else {
          setFetchFailed(true);
        }
      } catch {
        setFetchFailed(true);
      }
    };
    fetchProfile();
  }, [card.providerId, card.type, isClinic, isAgency]);

  if (isClinic) {
    return <ClinicMatchCard card={card} brandColor={brandColor} onAction={onAction} onViewProfile={onViewProfile} />;
  }

  if (isAgency) {
    return <AgencyMatchCard card={card} brandColor={brandColor} onAction={onAction} />;
  }

  if (!profile && !card.photo) {
    if (fetchFailed) {
      return (
        <div className="w-full rounded-[var(--container-radius)] overflow-hidden bg-muted border border-border p-4 text-center">
          <p className="text-sm font-ui text-muted-foreground">{card.name || cardType || "Profile"}</p>
          <p className="text-xs text-muted-foreground mt-1">Profile unavailable</p>
        </div>
      );
    }
    return (
      <div className="w-full aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile) {
    const t = cardType.toLowerCase();
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
        className="w-full aspect-[3/4] overflow-hidden animate-[slideUp_0.4s_ease-out_forwards]"
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
          onViewFullProfile={() => onViewProfile({ ...card, ownerProviderId: card.ownerProviderId || profile?.providerId })}
        />
      </div>
    );
  }

  return (
    <div
      className="w-full aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted cursor-pointer relative"
      data-testid={`match-card-${card.providerId}`}
      onClick={() => onViewProfile({ ...card, ownerProviderId: card.ownerProviderId || profile?.providerId })}
    >
      {card.photo ? (
        <img src={getPhotoSrc(card.photo) || undefined} alt={card.name} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center px-6" style={{ backgroundColor: `${brandColor}10` }}>
          <div className="w-20 h-20 rounded-full flex items-center justify-center text-primary-foreground text-3xl font-bold mb-4" style={{ backgroundColor: brandColor }}>
            {(card.name || "").charAt(0)}
          </div>
          <h3 className="font-heading text-xl text-center leading-tight">{card.name}</h3>
          {card.location && <p className="text-muted-foreground text-sm mt-1">{card.location}</p>}
        </div>
      )}
      {card.photo && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
          <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
          {card.location && <p className="text-white/70 text-sm mt-1">{card.location}</p>}
        </div>
      )}
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
    const fileUrl = getPhotoSrc(data.url) || data.url;
    return (
      <div data-testid="concierge-attachment-card">
        {isImage ? (
          <a href={fileUrl} target="_blank" rel="noopener noreferrer">
            <img src={fileUrl} alt={data.originalName} className="max-w-[240px] rounded-[var(--radius)] border" />
          </a>
        ) : (
          <a
            href={fileUrl}
            download={data.originalName}
            className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] border bg-background hover:bg-muted transition-colors"
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
        <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-muted/50 w-full text-left opacity-60" style={{ borderColor: brandColor }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground/70 shrink-0" style={{ backgroundColor: brandColor }}>
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
        className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors cursor-pointer w-full text-left"
        style={{ borderColor: brandColor }}
        data-testid="concierge-video-invite"
      >
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
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
        className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
        style={{ borderColor: brandColor }}
        data-testid="concierge-calendar-share"
      >
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
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

  if (msg.uiCardType === "agreement_signed") {
    return (
      <a
        href={data.agreementId ? `/agreements/${data.agreementId}` : "#"}
        className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
        style={{ borderColor: brandColor }}
      >
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
          <CheckCircle2 className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Agreement Fully Signed</p>
          <p className="text-xs text-muted-foreground">Tap to view and download the signed agreement</p>
        </div>
        <Download className="w-4 h-4 text-muted-foreground shrink-0" />
      </a>
    );
  }

  return null;
}

export function ParentChatSidePanel({
  subjectInfo,
  subjectSections,
  subjectPhotoUrl,
  providerName,
  sessionCalendarSlug,
  sessionBookings,
  brandColor,
}: {
  subjectInfo: ConsultationCardData | null;
  subjectSections: SidebarSection[];
  subjectPhotoUrl: string | null;
  providerName: string | null;
  sessionCalendarSlug: { slug: string | null; memberName: string | null } | null;
  sessionBookings: any[] | null;
  brandColor: string;
}) {
  const navigate = useNavigate();

  const profileSlug = subjectInfo ? getProfileUrlSlug(subjectInfo.subjectType || "surrogate") : null;
  const profileUrl =
    subjectInfo?.subjectProfileId && subjectInfo?.providerId && profileSlug
      ? `/${profileSlug}/${subjectInfo.providerId}/${subjectInfo.subjectProfileId}`
      : null;

  const existingBooking =
    sessionBookings?.find(
      (b: any) =>
        b.providerUser?.provider?.id === subjectInfo?.providerId ||
        b.providerId === subjectInfo?.providerId
    ) ??
    sessionBookings?.[0] ??
    null;

  const displayProviderName = subjectInfo?.providerName || providerName;

  return (
    <div className="w-72 border-l overflow-y-auto bg-muted/30 hidden md:flex md:flex-col shrink-0">
      <div className="p-4 space-y-4">
        {/* Profile Section - only after a call has been scheduled */}
        {subjectInfo && existingBooking && (
          <div>
            {/* Profile ID row with inline photo */}
            <div className="flex items-center gap-2.5 mb-2">
              {subjectPhotoUrl ? (
                <div className="w-10 h-10 rounded-full overflow-hidden bg-muted shrink-0">
                  <img
                    src={getPhotoSrc(subjectPhotoUrl) || undefined}
                    alt={subjectInfo.profileLabel || "Profile"}
                    className="w-full h-full object-cover object-top"
                  />
                </div>
              ) : (
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0"
                  style={{ backgroundColor: brandColor }}
                >
                  {(subjectInfo.profileLabel || "?").charAt(0)}
                </div>
              )}
              <p className="text-sm font-semibold leading-tight">{subjectInfo.profileLabel || "-"}</p>
            </div>
            {profileUrl && (
              <button
                className="text-xs flex items-center gap-1 mb-3"
                style={{ color: brandColor }}
                onClick={() => navigate(profileUrl)}
              >
                <ExternalLink className="w-3 h-3" />
                View Full Profile
              </button>
            )}
            {subjectSections.map((section, i) => (
              <div key={i} className={i > 0 ? "border-t pt-2 mt-2" : "mt-1"}>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  {section.title}
                </p>
                <div className="space-y-1">
                  {section.rows.map((row, j) => (
                    <div key={j} className="flex items-center gap-1.5 text-xs">
                      {row.icon && <row.icon className="w-3 h-3 text-muted-foreground shrink-0" />}
                      <span className="text-muted-foreground shrink-0">{row.label}:</span>
                      <span className="text-foreground">{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Provider Section - only after a call has been scheduled */}
        {displayProviderName && existingBooking && (
          <div className={subjectInfo && existingBooking ? "border-t pt-3" : ""}>
            <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>
              Agency
            </h4>
            <div className="flex items-center gap-2.5">
              {subjectInfo?.providerLogo ? (
                <img
                  src={getPhotoSrc(subjectInfo.providerLogo) || undefined}
                  alt={displayProviderName}
                  className="w-9 h-9 rounded-full object-cover border"
                />
              ) : (
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0"
                  style={{ backgroundColor: brandColor }}
                >
                  {(displayProviderName || "A").charAt(0)}
                </div>
              )}
              <span className="text-sm font-medium">{displayProviderName}</span>
            </div>
          </div>
        )}

        {/* Calendar Section */}
        {sessionCalendarSlug?.slug && (
          <div className={existingBooking && (displayProviderName || subjectInfo) ? "border-t pt-3" : ""}>
            <h4 className="font-semibold text-sm mb-1" style={{ fontFamily: "var(--font-display)" }}>
              Coordinator
            </h4>
            {(sessionCalendarSlug.memberName || subjectInfo?.memberName) && (
              <p className="text-sm text-muted-foreground mb-3">
                {sessionCalendarSlug.memberName || subjectInfo?.memberName}
              </p>
            )}
            <InlineBookingCalendar
              slug={sessionCalendarSlug.slug}
              memberName={sessionCalendarSlug.memberName || subjectInfo?.memberName || "Coordinator"}
              brandColor={brandColor}
              existingBooking={existingBooking || undefined}
              consultationMeta={subjectInfo ? {
                providerId: subjectInfo.providerId,
                profileLabel: subjectInfo.profileLabel,
                profilePhotoUrl: subjectInfo.profilePhotoUrl,
                subjectProfileId: subjectInfo.subjectProfileId,
                subjectType: subjectInfo.subjectType,
              } : undefined}
              autoResetOnCancel
              showCalendarOnExpiry
            />
          </div>
        )}
      </div>
    </div>
  );
}

export interface ParentSidePanelData {
  providerInChat: boolean;
  subjectInfo: ConsultationCardData | null;
  subjectSections: SidebarSection[];
  subjectPhotoUrl: string | null;
  providerName: string | null;
  sessionCalendarSlug: { slug: string | null; memberName: string | null } | null;
  sessionBookings: any[] | null;
}

interface ConciergeChatProps {
  inlineSessionId?: string;
  inlineMatchmakerId?: string;
  isInline?: boolean;
  externalBookingSlug?: { slug: string; memberName: string } | null;
  onCloseExternalBooking?: () => void;
  talkToTeamRef?: React.MutableRefObject<{ trigger: () => void; escalated: boolean } | null>;
  onSidePanelChange?: (data: ParentSidePanelData | null) => void;
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null }) => void;
}

export default function ConciergeChatPage({ inlineSessionId, inlineMatchmakerId, isInline, externalBookingSlug, onCloseExternalBooking, talkToTeamRef, onSidePanelChange, onBookingConfirmed }: ConciergeChatProps = {}) {
  const [searchParams] = useSearchParams();
  const matchmakerId = isInline ? (inlineMatchmakerId || null) : searchParams.get("matchmaker");
  const existingSessionId = isInline ? (inlineSessionId || null) : searchParams.get("session");
  // isEmbedded = fully embedded in an iframe (embedded=1 param); isInline = rendered inside ConversationsShell
  const isEmbedded = searchParams.get("embedded") === "1";
  const donorIdParam = searchParams.get("donorId");
  const donorTypeParam = searchParams.get("donorType");
  const donorProviderIdParam = searchParams.get("providerId");
  const donorPhotoParam = searchParams.get("photoUrl");
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
  const showCurationRef = useRef(false);
  const [pendingCurationMessage, setPendingCurationMessage] = useState<ChatMessage | null>(null);
  const curationAwaitingRef = useRef(false);
  const [humanEscalated, setHumanEscalated] = useState(false);
  const [humanInChat, setHumanInChat] = useState(false);
  const [bookingCard, setBookingCard] = useState<ConsultationCardData | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [greetingSet, setGreetingSet] = useState(false);
  const [providerInChat, setProviderInChat] = useState(false);
  const [providerChatName, setProviderChatName] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  // Session-level subject info returned directly from the API (used when no consultation card is in messages)
  const [sessionSubjectInfo, setSessionSubjectInfo] = useState<{ subjectProfileId: string; subjectType: string; profilePhotoUrl?: string | null; providerLogo?: string | null; providerId?: string } | null>(null);
  const [conciergeBookingSlug, setConciergeBookingSlug] = useState<{ slug: string; memberName: string } | null>(null);
  const parentFileInputRef = useRef<HTMLInputElement>(null);
  const [parentUploading, setParentUploading] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  // Ref so uploadAndSendFiles can access the current matchmaker ID without TDZ issues
  const effectiveMatchmakerIdRef = useRef<string | null>(null);

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
        setTimeout(() => {
          const container = messagesEndRef.current?.closest('[data-testid="concierge-messages"]');
          if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        }, 100);
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

  const handleParentFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Snapshot to array BEFORE clearing value - Safari/Chrome invalidate FileList on value reset
    const fileArray = Array.from(files);
    e.target.value = "";
    setStagedFiles(prev => [...prev, ...fileArray]);
  }, []);

  const removeStagedFile = useCallback((index: number) => {
    setStagedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const uploadAndSendFiles = useCallback(async (filesToUpload: File[], messageText: string) => {
    if (filesToUpload.length === 0) return;
    setStagedFiles([]);
    setParentUploading(true);
    setSending(true);
    sendingRef.current = true;

    const now = new Date().toISOString();
    const tempId = `temp-${Date.now()}`;

    try {
      // Step 1: Upload all files
      const uploadedFiles: Array<{ originalName: string; url: string; mimeType: string; size: number }> = [];
      for (const file of filesToUpload) {
        const formData = new FormData();
        formData.append("file", file);
        const uploadRes = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          throw new Error(errData.message || `Upload failed (${uploadRes.status})`);
        }
        uploadedFiles.push(await uploadRes.json());
      }

      const firstFile = uploadedFiles[0];
      const extraFiles = uploadedFiles.slice(1);
      const fileNames = uploadedFiles.map(f => f.originalName).join(", ");
      const displayText = messageText.trim() || `Shared a file: ${firstFile.originalName}`;
      const aiText = messageText.trim()
        ? `${messageText.trim()} [Attached file: ${fileNames}]`
        : `I've shared a file with you: ${fileNames}. Please acknowledge it.`;

      // Step 2: Show optimistic message with file card immediately
      setMessages(prev => [...prev, {
        role: "user" as const,
        content: displayText,
        createdAt: now,
        id: tempId,
        uiCardType: "attachment" as const,
        uiCardData: firstFile,
      }]);

      // Step 3: Call AI with attachmentData - it saves ONE unified user message (text + attachment)
      const aiRes = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: aiText,
          sessionId,
          matchmakerId: effectiveMatchmakerIdRef.current,
          attachmentData: firstFile,
        }),
      });

      if (!aiRes.ok) {
        setMessages(prev => prev.filter(m => m.id !== tempId));
        const errData = await aiRes.json().catch(() => ({}));
        throw new Error(errData.error || `AI request failed (${aiRes.status})`);
      }

      const aiData = await aiRes.json();

      // Step 4: Update session ID if new session was created
      if (aiData.sessionId && aiData.sessionId !== sessionId) {
        setSessionId(aiData.sessionId);
        queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
      }

      // Remove optimistic - real user message was saved by AI endpoint
      setMessages(prev => prev.filter(m => m.id !== tempId));

      // Show AI response
      if (aiData.message?.content) {
        const aiMsgId = aiData.message.id;
        setMessages(prev => {
          if (aiMsgId && prev.some(m => m.id === aiMsgId)) return prev;
          return [...prev, {
            role: "assistant" as const,
            content: aiData.message.content,
            createdAt: aiData.message.createdAt || now,
            id: aiMsgId,
            quickReplies: aiData.quickReplies,
            matchCards: aiData.matchCards,
            senderType: aiData.message.senderType,
            senderName: aiData.message.senderName,
          }];
        });
        if (aiData.message.id) knownMessageIds.current.add(aiData.message.id);
      }

      // Save additional files as separate attachment messages (fire-and-forget)
      const resolvedSessionId = aiData.sessionId || sessionId;
      if (resolvedSessionId && extraFiles.length > 0) {
        for (const extraFile of extraFiles) {
          fetch(`/api/chat-session/${resolvedSessionId}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              content: `Shared a file: ${extraFile.originalName}`,
              uiCardType: "attachment",
              uiCardData: extraFile,
            }),
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      alert(e.message || "Failed to upload file. Please try again.");
    } finally {
      setParentUploading(false);
      setSending(false);
      sendingRef.current = false;
    }
  }, [sessionId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const lastPollTimeRef = useRef<string | null>(null);
  const knownMessageIds = useRef<Set<string>>(new Set());
  const statusPollCounter = useRef(0);

  const matchmakers: Matchmaker[] = brand?.matchmakers || [];
  const [resolvedMatchmakerId, setResolvedMatchmakerId] = useState<string | null>(null);
  const [resolvedMatchmakerName, setResolvedMatchmakerName] = useState<string | null>(null);
  const effectiveMatchmakerId = matchmakerId || resolvedMatchmakerId
    || (donorIdParam && matchmakers.find(m => m.isActive)?.id) || null;
  effectiveMatchmakerIdRef.current = effectiveMatchmakerId;
  const selectedMatchmaker = matchmakers.find((m) => m.id === effectiveMatchmakerId);
  const aiName = selectedMatchmaker?.name || resolvedMatchmakerName || null;

  // Sync resolvedMatchmakerName from brand settings when effectiveMatchmakerId resolves
  useEffect(() => {
    if (!effectiveMatchmakerId || resolvedMatchmakerName) return;
    const mm = matchmakers.find((m) => m.id === effectiveMatchmakerId);
    if (mm) setResolvedMatchmakerName(mm.name);
  }, [effectiveMatchmakerId, matchmakers]);

  // Resolved avatar URL: use selectedMatchmaker when brand has loaded, otherwise fall back
  // to the sessionStorage cache written by the matchmaker-selection page so the header
  // renders the real photo instantly instead of showing the letter placeholder.
  const resolvedAvatarUrl = useMemo(() => {
    if (selectedMatchmaker?.avatarUrl) {
      return getPhotoSrc(selectedMatchmaker.avatarUrl) || selectedMatchmaker.avatarUrl;
    }
    if (!effectiveMatchmakerId) return null;
    // Fall back to localStorage brand cache (persists across page loads / direct URL navigation)
    try {
      const raw = localStorage.getItem("gostork_brand_settings");
      if (raw) {
        const brand = JSON.parse(raw);
        const mm = (brand?.matchmakers || []).find((m: any) => m.id === effectiveMatchmakerId);
        if (mm?.avatarUrl) return getPhotoSrc(mm.avatarUrl) || mm.avatarUrl;
      }
    } catch {
      // localStorage unavailable
    }
    return null;
  }, [selectedMatchmaker?.avatarUrl, effectiveMatchmakerId]);

  // Preload the matchmaker avatar so it's in the browser cache before the header renders
  useEffect(() => {
    if (!resolvedAvatarUrl) return;
    const img = new Image();
    img.src = resolvedAvatarUrl;
  }, [resolvedAvatarUrl]);

  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);

  const loadMessagesForSession = async (sid: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/ai-concierge/session/${sid}/messages`, { credentials: "include" });
      if (!res.ok) return false;
      const data = await res.json();
      const msgs = Array.isArray(data) ? data : (data.messages || []);
      setSessionTitle(data.sessionTitle || null);
      if (data.providerName) setProviderChatName(data.providerName);
      if (data.providerJoined) setProviderInChat(true);
      if (data.matchmakerId) setResolvedMatchmakerId(data.matchmakerId);
      if (data.matchmakerName) setResolvedMatchmakerName(data.matchmakerName);
      // Sync human escalation state: active only when humanRequested=true AND not yet concluded
      if (typeof data.humanRequested === "boolean") {
        setHumanEscalated(data.humanRequested && !data.humanConcludedAt);
        setHumanInChat(!!data.humanJoinedAt && !data.humanConcludedAt);
      }
      if (data.subjectProfileId && data.subjectType) {
        setSessionSubjectInfo({
          subjectProfileId: data.subjectProfileId,
          subjectType: data.subjectType,
          profilePhotoUrl: data.profilePhotoUrl || null,
          providerLogo: data.providerLogo || null,
          providerId: data.sessionProviderId || undefined,
        });
      }
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
            agreementCard: extras.agreementCard,
            uiCardType: m.uiCardType,
            uiCardData: m.uiCardData,
            deliveredAt: m.deliveredAt,
            readAt: m.readAt,
            createdAt: m.createdAt,
          };
        });
        setMessages(parsed);
        setGreetingSet(true);
        lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
        msgs.forEach((m: any) => { if (m.id) knownMessageIds.current.add(m.id); });
        if (msgs.some((m: any) => m.senderType === "provider")) setProviderInChat(true);
        // Send read receipt
        fetch(`/api/chat-sessions/${existingSessionId}/read`, { method: "POST", credentials: "include" }).catch(() => {});
      }
    } catch { return false; }
    return true;
  };

  useEffect(() => {
    if (sessionLoaded) return;

    if (existingSessionId) {
      (async () => {
        const found = await loadMessagesForSession(existingSessionId);
        if (!found) {
          // Session no longer exists (e.g. after "Delete All Chats") - clear the stale URL
          // param so existingSessionId becomes null and the greeting effect can fire.
          setSessionId(null);
          navigate(window.location.pathname, { replace: true });
        }
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
                  deliveredAt: m.deliveredAt,
                  readAt: m.readAt,
                  createdAt: m.createdAt,
                };
              });
              setMessages(parsed);
              setGreetingSet(true);
              lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
              msgs.forEach((m: any) => { if (m.id) knownMessageIds.current.add(m.id); });
              if (msgs.find((m: any) => m.senderType === "provider")) setProviderInChat(true);
            }
          }
        }
      } catch {}
      setSessionLoaded(true);
    })();
  }, [existingSessionId, matchmakerId, donorIdParam, sessionLoaded]);

  // Persist the resolved session ID into the URL so page refresh reloads the same session.
  // This runs in a separate effect that only fires after sessionLoaded=true, so the
  // session-loading effect above will bail immediately (sessionLoaded guard) on the
  // re-render caused by navigate, preventing double-loads or duplicate greetings.
  useEffect(() => {
    if (isInline || !sessionId || !sessionLoaded) return;
    if (searchParams.get("session") === sessionId) return;
    navigate(`?session=${sessionId}`, { replace: true });
  }, [sessionId, sessionLoaded, isInline]);

  // Initial scroll - use container scroll, not window scroll
  useEffect(() => {
    const container = document.querySelector('[data-testid="concierge-messages"]');
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  const parentProfileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!user,
    staleTime: 0,           // always treat cached data as stale
    refetchOnMount: true,   // always refetch on component mount
  });

  // Subject profile info for the right panel: prefer consultation card from messages, fall back to session-level data
  const subjectInfo = useMemo<ConsultationCardData | null>(() => {
    for (const msg of [...messages].reverse()) {
      if (msg.consultationCard?.subjectProfileId) return msg.consultationCard;
    }
    // Fall back to session-level subject data returned by the API
    if (sessionSubjectInfo?.subjectProfileId && sessionSubjectInfo?.providerId) {
      return {
        providerId: sessionSubjectInfo.providerId,
        providerName: providerChatName || "",
        providerLogo: sessionSubjectInfo.providerLogo || undefined,
        subjectProfileId: sessionSubjectInfo.subjectProfileId,
        subjectType: sessionSubjectInfo.subjectType,
        profilePhotoUrl: sessionSubjectInfo.profilePhotoUrl || undefined,
        profileLabel: sessionTitle?.split(" x ")?.[0]?.trim() || undefined,
      } as ConsultationCardData;
    }
    return null;
  }, [messages, sessionSubjectInfo, providerChatName, sessionTitle]);

  const subjectProfileApiPath = useMemo(() => {
    if (!subjectInfo?.subjectProfileId || !subjectInfo?.providerId || !subjectInfo?.subjectType) return null;
    const t = subjectInfo.subjectType.toLowerCase();
    const endpoint = t === "surrogate" ? "surrogates" : t.includes("sperm") ? "sperm-donors" : "egg-donors";
    return `/api/providers/${subjectInfo.providerId}/${endpoint}/${subjectInfo.subjectProfileId}`;
  }, [subjectInfo]);

  const { data: subjectProfileData = null } = useQuery<any>({
    queryKey: ["subject-profile", subjectInfo?.subjectProfileId],
    queryFn: async () => {
      const res = await fetch(subjectProfileApiPath!, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!subjectProfileApiPath && providerInChat,
    staleTime: 300000,
  });

  const { subjectSections, subjectPhotoUrl } = useMemo((): { subjectSections: SidebarSection[]; subjectPhotoUrl: string | null } => {
    if (!subjectProfileData || !subjectInfo?.subjectType) return { subjectSections: [], subjectPhotoUrl: subjectInfo?.profilePhotoUrl || null };
    const t = subjectInfo.subjectType.toLowerCase();
    const swipeProfile = t === "surrogate"
      ? mapDatabaseSurrogateToSwipeProfile(subjectProfileData)
      : t.includes("sperm")
        ? mapDatabaseSpermDonorToSwipeProfile(subjectProfileData)
        : mapDatabaseDonorToSwipeProfile(subjectProfileData);
    const photo = swipeProfile.photos?.[0] || swipeProfile.photoUrl || subjectInfo?.profilePhotoUrl || null;
    return { subjectSections: buildSidebarSections(swipeProfile, t.includes("sperm")), subjectPhotoUrl: photo };
  }, [subjectProfileData, subjectInfo?.subjectType, subjectInfo?.profilePhotoUrl]);

  const initialScrollDone = useRef(false);
  // Track whether the user is near the bottom (within 120px). Only auto-scroll when they are.
  const userNearBottom = useRef(true);
  const scrollToBottom = useRef((behavior?: "smooth") => {
    if (messagesEndRef.current) {
      const container = messagesEndRef.current.closest('[data-testid="concierge-messages"]') as HTMLElement | null;
      if (container) {
        if (behavior === "smooth") {
          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }
    }
  });
  const scrollToBottomIfNear = useRef((behavior?: "smooth") => {
    if (!userNearBottom.current) return;
    scrollToBottom.current(behavior);
  });

  // When inline, notify parent about side panel data so it can render the panel at the correct DOM level
  useEffect(() => {
    if (!isInline || !onSidePanelChange) return;
    onSidePanelChange({
      providerInChat,
      subjectInfo,
      subjectSections,
      subjectPhotoUrl,
      providerName: providerChatName,
      sessionCalendarSlug: sessionCalendarSlug ?? null,
      sessionBookings: sessionBookings ?? null,
    });
  }, [isInline, providerInChat, subjectInfo, subjectSections, subjectPhotoUrl, providerChatName, sessionCalendarSlug, sessionBookings]);

  // Cleanup side panel when unmounting
  useEffect(() => {
    if (!isInline || !onSidePanelChange) return;
    return () => { onSidePanelChange(null); };
  }, [isInline]);

  // When on the standalone /concierge route and no onBookingConfirmed callback is provided,
  // navigate to the full provider chat view when the booking is confirmed.
  // For the inline (ConversationsPage) case this is handled via the onBookingConfirmed prop.
  // We use the callback from InlineBookingCalendar's onSuccess for reliability (no polling).
  // This effect is kept as a fallback for sessions already in progress when the page loads.
  useEffect(() => {
    if (isInline || onBookingConfirmed) return;
    if (!sessionBookings?.length) return;

    // Bookings are ordered by createdAt desc - first is newest
    const newest = sessionBookings[0];
    if (!newest?.createdAt) return;
    const ageMs = Date.now() - new Date(newest.createdAt).getTime();
    if (ageMs > 15000) return; // only act on very recently created bookings (< 15s)

    const providerId = subjectInfo?.providerId;
    const subjectProfileId = subjectInfo?.subjectProfileId;
    if (providerId && subjectProfileId) {
      navigate(`/chat/${providerId}/${subjectProfileId}`, { replace: true });
    } else if (providerId) {
      navigate(`/chat`, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionBookings?.length, isInline]);

  // Track whether user is near the bottom so we know if auto-scroll should fire
  useEffect(() => {
    const container = document.querySelector('[data-testid="concierge-messages"]') as HTMLElement | null;
    if (!container) return;
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      userNearBottom.current = distFromBottom < 120;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Scroll to bottom on messages change
  useEffect(() => {
    if (!messages.length) return;
    if (!initialScrollDone.current) {
      // Initial load: always scroll to bottom unconditionally
      scrollToBottom.current();
      const t1 = setTimeout(() => scrollToBottom.current(), 150);
      const t2 = setTimeout(() => scrollToBottom.current(), 400);
      const t3 = setTimeout(() => scrollToBottom.current(), 800);
      const t4 = setTimeout(() => {
        scrollToBottom.current();
        initialScrollDone.current = true;
        userNearBottom.current = true;
      }, 1500);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
    } else {
      // New message arrived - only scroll if user is already near the bottom
      scrollToBottomIfNear.current("smooth");
      const t1 = setTimeout(() => scrollToBottomIfNear.current("smooth"), 150);
      const t2 = setTimeout(() => scrollToBottomIfNear.current("smooth"), 400);
      const t3 = setTimeout(() => scrollToBottomIfNear.current("smooth"), 800);
      const t4 = setTimeout(() => scrollToBottomIfNear.current("smooth"), 1500);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
    }
  }, [messages, sessionBookings?.length]);

  // Watch for layout shifts (image loads, card renders) and keep scrolled to bottom
  useEffect(() => {
    const container = document.querySelector('[data-testid="concierge-messages"]');
    if (!container || !messages.length) return;

    // Only scroll on DOM mutations if user is near the bottom
    const scrollDown = () => {
      if (userNearBottom.current) container.scrollTop = (container as HTMLElement).scrollHeight;
    };

    // MutationObserver catches DOM changes (new elements, attribute changes from image loads)
    const mutObs = new MutationObserver(scrollDown);
    mutObs.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style", "class"] });

    // Capture image load events bubbling up
    container.addEventListener("load", scrollDown, true);

    // Stop observing after 3 seconds to avoid interfering with user scroll
    const stopTimer = setTimeout(() => {
      mutObs.disconnect();
      container.removeEventListener("load", scrollDown, true);
    }, 3000);

    return () => {
      mutObs.disconnect();
      container.removeEventListener("load", scrollDown, true);
      clearTimeout(stopTimer);
    };
  }, [messages.length, sessionBookings?.length]);

  useEffect(() => {
    if (externalBookingSlug) {
      setTimeout(() => {
        const container = messagesEndRef.current?.closest('[data-testid="concierge-messages"]');
        if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      }, 100);
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
        if (rawData.matchmakerId) setResolvedMatchmakerId(rawData.matchmakerId);
        if (rawData.matchmakerName) setResolvedMatchmakerName(rawData.matchmakerName);
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
                agreementCard: extras.agreementCard,
                quickReplies: extras.quickReplies,
                multiSelect: extras.multiSelect,
                uiCardType: m.uiCardType,
                uiCardData: m.uiCardData,
                deliveredAt: m.deliveredAt,
                readAt: m.readAt,
                createdAt: m.createdAt,
              };
            }),
          ]);
          lastPollTimeRef.current = unseenMsgs[unseenMsgs.length - 1].createdAt;
          if (unseenMsgs.some((m: any) => m.senderType === "provider")) {
            setProviderInChat(true);
          }
          // Mark newly polled messages as read since user is actively viewing this chat
          fetch(`/api/chat-sessions/${sessionId}/read`, { method: "POST", credentials: "include" }).catch(() => {});
        }

        // Periodically refresh delivery status on existing messages (every 3rd poll)
        statusPollCounter.current = (statusPollCounter.current || 0) + 1;
        if (statusPollCounter.current >= 3) {
          statusPollCounter.current = 0;
          const statusRes = await fetch(`/api/ai-concierge/session/${sessionId}/messages`, { credentials: "include" });
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.providerJoined && !providerInChat) {
              if (statusData.providerName) setProviderChatName(statusData.providerName);
              setProviderInChat(true);
            }
            // Sync human escalation state from server on every status poll
            if (typeof statusData.humanRequested === "boolean") {
              setHumanEscalated(statusData.humanRequested && !statusData.humanConcludedAt);
              setHumanInChat(!!statusData.humanJoinedAt && !statusData.humanConcludedAt);
            }
            const allMsgs: any[] = Array.isArray(statusData) ? statusData : (statusData.messages || []);
            const statusMap = new Map(allMsgs.map((m: any) => [m.id, { deliveredAt: m.deliveredAt, readAt: m.readAt }]));
            setMessages(prev => {
              let changed = false;
              const updated = prev.map(m => {
                if (!m.id) return m;
                const status = statusMap.get(m.id);
                if (status && (status.deliveredAt !== m.deliveredAt || status.readAt !== m.readAt)) {
                  changed = true;
                  return { ...m, deliveredAt: status.deliveredAt, readAt: status.readAt };
                }
                return m;
              });
              return changed ? updated : prev;
            });
          }
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (greetingSet || !selectedMatchmaker || !user) return;
    if (!donorIdParam && !sessionLoaded) return;
    if (!donorIdParam && (sessionId || existingSessionId)) return;
    setGreetingSet(true);

    // For donor deep-links: build greeting client-side immediately (no profile needed)
    if (donorIdParam) {
      const u = user as any;
      const firstName = u.firstName || u.name?.split(" ")[0] || "there";
      const donorLabel = donorTypeParam === "surrogate" ? "Surrogate" : donorTypeParam === "sperm-donor" ? "Sperm Donor" : "Egg Donor";
      const greeting = `Hi ${firstName}! I see you're interested in learning more about a ${donorLabel} profile. I'd love to help you with any questions you have. Do you have a specific question about this ${donorLabel.toLowerCase()}?`;
      const greetingMatchCards: MatchCard[] = [{
        name: donorLabel, type: donorLabel, providerId: donorIdParam,
        ownerProviderId: donorProviderIdParam || undefined,
        photo: donorPhotoParam || undefined, reasons: [],
      }];
      setMessages([{ role: "assistant", content: greeting, createdAt: new Date().toISOString(), matchCards: greetingMatchCards }]);
      (async () => {
        try {
          const res = await fetch("/api/ai-concierge/init-session", {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
            body: JSON.stringify({ matchmakerId: effectiveMatchmakerId, greeting, donorId: donorIdParam, donorType: donorTypeParam, ownerProviderId: donorProviderIdParam || undefined }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.sessionId) setSessionId(data.sessionId);
            if (data.greetingMessageId) knownMessageIds.current.add(data.greetingMessageId);
          }
        } catch {}
      })();
      return;
    }

    // For normal chat: call init-session and let server build greeting + phase0 with correct services
    // Show a minimal placeholder while waiting so UI feels instant
    (async () => {
      try {
        const res = await fetch("/api/ai-concierge/init-session", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ matchmakerId: effectiveMatchmakerId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.sessionId) setSessionId(data.sessionId);
        if (data.greetingMessageId) knownMessageIds.current.add(data.greetingMessageId);
        if (data.phase0MessageId) knownMessageIds.current.add(data.phase0MessageId);

        // Display server-built greeting and phase0
        const initialMessages: typeof messages = [];
        if (data.greeting) {
          initialMessages.push({ role: "assistant", content: data.greeting, createdAt: new Date().toISOString() });
        }
        if (data.phase0Content) {
          initialMessages.push({ role: "assistant", content: data.phase0Content, createdAt: new Date().toISOString() });
        }
        if (initialMessages.length) setMessages(initialMessages);

        // Trigger AI to ask Phase 1 (or B1/C1 for donor-only parents)
        if (!data.reused && data.sessionId) {
          setSending(true);
          sendingRef.current = true;
          try {
            const phase1Res = await fetch("/api/ai-concierge/chat", {
              method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
              body: JSON.stringify({ message: "phase1_init", isSystemTrigger: true, sessionId: data.sessionId, matchmakerId: effectiveMatchmakerId }),
            });
            if (phase1Res.ok) {
              const phase1Data = await phase1Res.json();
              if (phase1Data.message?.id) knownMessageIds.current.add(phase1Data.message.id);
              if (phase1Data.message?.content) {
                setMessages((prev) => [...prev, {
                  role: "assistant" as const,
                  content: phase1Data.message.content,
                  id: phase1Data.message.id,
                  quickReplies: phase1Data.quickReplies,
                  multiSelect: phase1Data.multiSelect,
                  createdAt: phase1Data.message.createdAt || new Date().toISOString(),
                }]);
              }
            }
          } catch {}
          setSending(false);
          sendingRef.current = false;
        }
      } catch {}
    })();
  }, [selectedMatchmaker, user, greetingSet, sessionLoaded, sessionId, existingSessionId, donorIdParam, donorTypeParam]);

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
    const hasFiles = stagedFiles.length > 0;
    if (!text.trim() && !hasFiles) return;
    if (sending || sendingRef.current || showCurationRef.current) return;

    // If curation is awaiting parent confirmation, show their message and start animation
    if (curationAwaitingRef.current) {
      const now = new Date().toISOString();
      setMessages((prev) => {
        const updated = prev.map((m, i) =>
          i === prev.length - 1 && m.quickReplies ? { ...m, quickReplies: undefined } : m
        );
        return [...updated, { role: "user" as const, content: text.trim(), createdAt: now }];
      });
      setInput("");
      curationAwaitingRef.current = false;
      setTimeout(() => { showCurationRef.current = true; setShowCuration(true); }, 800);
      return;
    }

    // Upload staged files + call AI (handles both file-only and file+text cases)
    if (hasFiles) {
      const filesToUpload = [...stagedFiles]; // capture before state clears
      setInput("");
      uploadAndSendFiles(filesToUpload, text); // fire-and-forget; manages its own state
      return;
    }

    if (!text.trim()) return;
    sendingRef.current = true;
    const userMessage = text.trim();
    setInput("");
    const now = new Date().toISOString();
    setMessages((prev) => {
      const updated = prev.map((m, i) =>
        i === prev.length - 1 && m.quickReplies ? { ...m, quickReplies: undefined } : m
      );
      return [...updated, { role: "user" as const, content: userMessage, createdAt: now }];
    });
    // Optimistically update sidebar with latest message (reset delivery status for new msg)
    if (sessionId) {
      queryClient.setQueryData<any[]>(["/api/my/chat-sessions"], (old) =>
        old?.map(s => s.id === sessionId ? { ...s, lastMessage: userMessage, lastMessageAt: now, lastMessageRole: "user", lastMessageSenderType: "parent", lastMessageDeliveredAt: null, lastMessageReadAt: null } : s)
      );
    }
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

      if (data.userMessageId) {
        knownMessageIds.current.add(data.userMessageId);
        // Back-fill the optimistic user message with its real id + deliveredAt + readAt
        setMessages(prev => prev.map(m =>
          m.role === "user" && m.content === userMessage && !m.id
            ? { ...m, id: data.userMessageId, deliveredAt: data.userMessageDeliveredAt || null, readAt: data.userMessageReadAt || null }
            : m
        ));
        // Update sidebar delivery status
        if (data.userMessageDeliveredAt && sessionId) {
          queryClient.setQueryData<any[]>(["/api/my/chat-sessions"], (old) =>
            old?.map(s => s.id === sessionId ? { ...s, lastMessageDeliveredAt: data.userMessageDeliveredAt } : s)
          );
        }
      }

      if (data.humanNeeded) {
        setHumanEscalated(true);
      }
      if (data.skipAiResponse) {
        setSending(false);
        sendingRef.current = false;
        return;
      }
      if (data.consultationCard) {
        // Open the right-side panel as soon as the AI connects the parent with a provider
        if (data.consultationCard.providerName) setProviderChatName(data.consultationCard.providerName);
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
        agreementCard: data.agreementCard,
        senderType: data.message.senderType,
        senderName: data.message.senderName,
        deliveredAt: data.message.deliveredAt,
        readAt: data.message.readAt,
        createdAt: data.message.createdAt || new Date().toISOString(),
      };

      if (data.showCuration) {
        setMessages((prev) => [...prev, newMessage]);
        setPendingCurationMessage(newMessage);
        curationAwaitingRef.current = true;
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

  useEffect(() => {
    if (talkToTeamRef) {
      talkToTeamRef.current = { trigger: handleTalkToTeam, escalated: humanEscalated };
    }
  }, [talkToTeamRef, humanEscalated]);

  // Immediately re-enable button when GoStork human exits
  useEffect(() => {
    const handler = () => { setHumanEscalated(false); setHumanInChat(false); };
    window.addEventListener("human-concluded", handler);
    return () => window.removeEventListener("human-concluded", handler);
  }, []);

  const handleCurationComplete = useCallback(async () => {
    showCurationRef.current = false;
    setShowCuration(false);
    if (!pendingCurationMessage) return;
    setPendingCurationMessage(null);

    // Send "ready" silently (not visible in chat) to trigger match search
    setSending(true);
    sendingRef.current = true;
    try {
      const res = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: "ready",
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
      if (data.skipAiResponse) return;
      if (data.humanNeeded) setHumanEscalated(true);
      if (data.message?.id) knownMessageIds.current.add(data.message.id);
      const newMessage: ChatMessage = {
        role: "assistant",
        content: data.message.content,
        id: data.message.id,
        quickReplies: data.quickReplies,
        multiSelect: data.multiSelect,
        matchCards: data.matchCards,
        prepDoc: data.prepDoc,
        consultationCard: data.consultationCard,
        agreementCard: data.agreementCard,
        senderType: data.message.senderType,
        senderName: data.message.senderName,
        deliveredAt: data.message.deliveredAt,
        readAt: data.message.readAt,
        createdAt: data.message.createdAt || new Date().toISOString(),
      };
      setMessages((prev) => [...prev, newMessage]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I'm sorry, I'm having trouble connecting right now. Please try again.", createdAt: new Date().toISOString() },
      ]);
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [pendingCurationMessage, sessionId, effectiveMatchmakerId]);

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
      <div
        className={`flex ${isInline ? "flex-1 min-h-0 min-w-0" : "h-dvh"} overflow-hidden${!isEmbedded && !isInline && !(providerInChat && (sessionBookings?.length ?? 0) > 0) ? " max-w-3xl mx-auto" : ""}`}
        data-testid="concierge-chat-page"
      >
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {!isEmbedded && !isInline && <div
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
          {providerInChat && (sessionBookings?.length ?? 0) > 0 && subjectInfo ? (
            /* Consultation mode: show "Subject x Provider" header layout */
            <>
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-muted">
                  {subjectInfo.profilePhotoUrl ? (
                    <img src={getPhotoSrc(subjectInfo.profilePhotoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                </div>
                <span className="font-semibold text-sm font-ui truncate">{subjectInfo.profileLabel || providerChatName}</span>
              </div>
              <span className="text-muted-foreground text-base font-medium flex-shrink-0 px-1" aria-hidden>x</span>
              <div className="flex items-center gap-2 min-w-0">
                {subjectInfo.providerLogo ? (
                  <img src={getPhotoSrc(subjectInfo.providerLogo) || undefined} alt={providerChatName || ""} className="w-10 h-10 rounded-full object-contain flex-shrink-0 border border-border bg-white" />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold flex-shrink-0" style={{ backgroundColor: brandColor }}>
                    {(providerChatName || "?").charAt(0)}
                  </div>
                )}
                <span className="font-semibold text-sm font-ui truncate">{providerChatName}</span>
              </div>
            </>
          ) : (
            /* Default: matchmaker avatar + name */
            <>
              <div className="w-12 h-12 rounded-full flex-shrink-0 relative">
                {!providerInChat && resolvedAvatarUrl && (
                  <img
                    src={resolvedAvatarUrl}
                    alt={selectedMatchmaker?.name || aiName || "AI Concierge"}
                    className="w-12 h-12 rounded-full object-cover border absolute inset-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold"
                  style={{ backgroundColor: brandColor }}
                >
                  {(providerInChat && providerChatName ? providerChatName : (aiName || "?")).charAt(0)}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-ui" style={{ fontWeight: 600 }}>
                  {providerInChat && providerChatName ? providerChatName : (aiName || "AI Concierge")}
                </h2>
                <p className="text-[11px] font-ui text-muted-foreground truncate" data-testid="chat-subject-label">
                  {providerInChat && sessionTitle ? sessionTitle : "AI Concierge Chat"}
                </p>
              </div>
            </>
          )}
          <div className="flex items-center gap-1 shrink-0 ml-auto">
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
            {!providerInChat && sessionLoaded && (
              humanInChat ? (
                <div
                  className="inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-full"
                  style={{ backgroundColor: `${brandColor}15`, color: brandColor, borderRadius: "999px" }}
                  data-testid="btn-talk-to-team"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  <span>Talking with Human</span>
                </div>
              ) : (
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
                  <span>{humanEscalated ? "Team Notified" : "Talk to GoStork Team"}</span>
                </Button>
              )
            )}
          </div>
        </div>}

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" data-testid="concierge-messages">
          {(() => {
            const shouldInlineBooking = !externalBookingSlug && !conciergeBookingSlug && sessionBookings && sessionBookings.length > 0;
            // Skip standalone booking card if a ConsultationBookingCard already shows this booking inline
            const consultationCardProviderIds = new Set(messages.filter(m => m.consultationCard?.providerId).map(m => m.consultationCard!.providerId));
            // Also track providerUserId for admin calendar cards (which have no providerId)
            const consultationCardProviderUserIds = new Set(messages.filter(m => m.consultationCard?.providerUserId).map(m => m.consultationCard!.providerUserId));
            const activeBooking = shouldInlineBooking
              ? sessionBookings!.find((b: any) =>
                  !consultationCardProviderIds.has(b.providerUser?.provider?.id) &&
                  !consultationCardProviderUserIds.has(b.providerUserId ?? b.providerUser?.id)
                ) || null
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
                          <CalendarCheck className="w-4 h-4 text-primary-foreground" />
                          <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
                            {`Consultation Call with ${item.booking.providerUser?.provider?.name || item.booking.providerUser?.name || "Provider"}`}
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
                  ? (msg.senderName === "GoStork" ? "GoStork" : aiName || "AI")
                  : (aiName || "AI");
                const alignRight = isOwnMessage || (!isOtherParent && msg.role === "user");
                return (
                  <>
                    {!alignRight && msg.matchCards && msg.matchCards.length > 0 && (
                      <div className="flex justify-start mb-2 ml-0">
                        <div className="space-y-3 w-[320px] sm:w-[380px]">
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
                        className={`relative max-w-[80%] overflow-hidden px-4 py-2.5 text-base leading-relaxed font-ui ${
                          isOwnMessage
                            ? "text-primary-foreground chat-bubble-dark"
                            : isOtherParent
                            ? "text-foreground"
                            : msg.role === "user"
                            ? "text-primary-foreground chat-bubble-dark"
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
                        <span style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>
                          {msg.content.split("\n").map((line, li) => {
                            const parts = line.split(/(\*\*[^*]+\*\*)/g);
                            return (
                              <Fragment key={li}>
                                {li > 0 && <br />}
                                {parts.map((part, pi) =>
                                  part.startsWith("**") && part.endsWith("**")
                                    ? <strong key={pi}>{part.slice(2, -2)}</strong>
                                    : <Fragment key={pi}>{part}</Fragment>
                                )}
                              </Fragment>
                            );
                          })}
                        </span>
                        {msg.createdAt && (
                          <>
                            <span className={`inline-block ${alignRight ? "w-[4.75rem]" : "w-[3.5rem]"}`} aria-hidden="true">&nbsp;</span>
                            <span
                              className="absolute bottom-1.5 right-3 whitespace-nowrap select-none flex items-center gap-0.5"
                              style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }}
                            >
                              {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                              {alignRight && (
                                <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />
                              )}
                            </span>
                          </>
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

              {msg.agreementCard && (
                <div className="flex justify-start mt-3 ml-0">
                  <AgreementSignCard card={msg.agreementCard} brandColor={brandColor} createdAt={msg.createdAt} />
                </div>
              )}

              {msg.consultationCard && (() => {
                // Only show consultation card on the LAST message that has one for this provider.
                // Must check m.consultationCard != null first - otherwise messages without a card
                // match via optional chaining returning undefined === undefined, causing admin
                // cards (no providerId) to never render if any later message exists.
                const lastMsgWithCard = [...messages].reverse().find(
                  m => m.consultationCard != null && m.consultationCard?.providerId === msg.consultationCard?.providerId
                );
                if (lastMsgWithCard && lastMsgWithCard !== msg) return null;
                return true;
              })() && (
                <div className="flex justify-start mt-3 ml-0">
                  <ConsultationBookingCard
                    card={msg.consultationCard}
                    brandColor={brandColor}
                    userEmail={(user as any)?.email || ""}
                    userName={(user as any)?.name || ""}
                    onCallbackSubmitted={() => {
                      setTimeout(async () => {
                        if (sessionId) {
                          await loadMessagesForSession(sessionId);
                          fetch("/api/ai-concierge/chat", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({
                              message: "consultation_callback_submitted",
                              sessionId,
                              matchmakerId: effectiveMatchmakerIdRef.current,
                              isSystemTrigger: true,
                            }),
                          }).then(r => r.ok ? r.json() : null).then(data => {
                            if (data && sessionId) loadMessagesForSession(sessionId);
                          }).catch(() => {});
                        }
                      }, 800);
                    }}
                    onSchedule={(c) => setBookingCard(c)}
                    onBookingConfirmed={onBookingConfirmed}
                    existingBooking={(() => {
                      if (!sessionBookings) return undefined;
                      // Use ?? null to normalise both undefined and null to null before comparing,
                      // because Prisma returns null for missing relations while JS optional chaining
                      // returns undefined - strict === would make them unequal.
                      const cardProviderId = msg.consultationCard?.providerId ?? null;
                      // Also match by providerUserId for admin calendar cards (no providerId).
                      const cardProviderUserId = msg.consultationCard?.providerUserId ?? null;
                      const providerBookings = sessionBookings.filter(
                        (b: any) => {
                          const bookingProviderId = (b.providerUser?.provider?.id ?? null);
                          const bookingProviderUserId = (b.providerUser?.id ?? b.providerUserId ?? null);
                          const idMatch = bookingProviderId === cardProviderId;
                          const userIdMatch = cardProviderUserId && bookingProviderUserId === cardProviderUserId;
                          return (idMatch || userIdMatch) && b.status !== "CANCELLED";
                        }
                      );
                      // Prefer the most recent non-cancelled booking
                      return providerBookings.sort((a: any, b: any) =>
                        new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime()
                      )[0];
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
              <span className="text-xs text-muted-foreground">{aiName || "AI Concierge"} is typing</span>
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
                      <CalendarCheck className="w-4 h-4 text-primary-foreground" />
                      <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">Schedule a Meeting</span>
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
          {stagedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {stagedFiles.map((file, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius)] border bg-muted/50 text-xs">
                  <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: brandColor }} />
                  <span className="truncate max-w-[140px]">{file.name}</span>
                  <button onClick={() => removeStagedFile(i)} className="ml-0.5 hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              ref={parentFileInputRef}
              type="file"
              className="hidden"
              accept="image/*,application/pdf,.doc,.docx,.txt"
              multiple
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
              placeholder={`Message ${providerInChat && providerChatName ? providerChatName : (aiName || "AI Concierge")}...`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending || parentUploading}
              className="flex-1 !text-base font-ui rounded-full"
              data-testid="input-concierge-message"
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={(!input.trim() && stagedFiles.length === 0) || sending || parentUploading}
              className="h-10 w-10 p-0 rounded-full text-primary-foreground shrink-0"
              style={{ backgroundColor: brandColor }}
              data-testid="btn-send-message"
            >
              {(sending || parentUploading) ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>

        </div>
        {providerInChat && !isEmbedded && !isInline && (sessionBookings?.length ?? 0) > 0 && (
          <ParentChatSidePanel
            subjectInfo={subjectInfo}
            subjectSections={subjectSections}
            subjectPhotoUrl={subjectPhotoUrl}
            providerName={providerChatName}
            sessionCalendarSlug={sessionCalendarSlug ?? null}
            sessionBookings={sessionBookings ?? null}
            brandColor={brandColor}
          />
        )}
      </div>
      {bookingCard && (
        <BookingOverlay
          card={bookingCard}
          brandColor={brandColor}
          userEmail={(user as any)?.email || ""}
          userName={(user as any)?.name || ""}
          onClose={() => setBookingCard(null)}
          onCallbackSubmitted={() => {
            // Reload messages to show confirmation, then trigger AI to continue with next cycle
            setTimeout(async () => {
              if (sessionId) {
                await loadMessagesForSession(sessionId);
                // Send a hidden trigger so the AI continues with the next pending match cycle
                fetch("/api/ai-concierge/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({
                    message: "consultation_callback_submitted",
                    sessionId,
                    matchmakerId: effectiveMatchmakerIdRef.current,
                    isSystemTrigger: true,
                  }),
                }).then(r => r.ok ? r.json() : null).then(data => {
                  if (data && sessionId) loadMessagesForSession(sessionId);
                }).catch(() => {});
              }
            }, 800);
          }}
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
