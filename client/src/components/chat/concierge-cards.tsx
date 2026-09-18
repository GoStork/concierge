/**
 * Concierge chat cards - the inline cards Eva posts into a chat: match cards
 * (donor / surrogate / clinic / agency / law group / country program), doctor
 * cards, the consultation + booking calendar, meeting, prep-doc and agreement
 * cards, and the booking overlay.
 *
 * These lived inside concierge-chat-page.tsx, which is why the parent was the
 * only surface that could render them: the admin concierge monitor and the
 * provider chat share ChatMessageList, and ChatMessageList had no access to a
 * single one of them. An admin watching a session saw Eva write "use the card
 * above to pick a date and time" with no card anywhere - the data was in
 * uiCardData the whole time, there was just no renderer on that side.
 *
 * Moved here verbatim so all three surfaces render the SAME components. Any
 * card type added here shows up on every surface from then on.
 */
import { useSyncExternalStore, useState, useEffect, useRef, useMemo } from "react";
import { TimezonePicker } from "@/components/calendar/timezone-picker";
import { ivfContextSearch } from "@/components/ivf-success-rates-section";
import { InlineBookingNotification } from "@/components/chat/inline-booking-notification";
import { ComparisonCard } from "@/components/chat/comparison-card";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useMarketplaceViewContext, recordProfileView, recordImpression } from "@/lib/profile-views";
import { getCountryFlag } from "@/lib/country-flag";
import { formatLocationDisplay } from "@/lib/format-location";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  getClinicTabs,
  buildDoctorCardProps,
  buildTitle,
  buildStatusLabel,
  getPhotoList,
  buildSidebarSections,
  type SidebarSection,
  type DoctorCardData,
} from "@/components/marketplace/swipe-mappers";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { ClinicSwipeCard } from "@/components/marketplace/clinic-swipe-card";
import { AgencySwipeCard } from "@/components/marketplace/agency-swipe-card";
import { LawGroupSwipeCard } from "@/components/marketplace/law-group-swipe-card";
import { Loader2, Send, FileText, Download, Heart, Brain, Stethoscope, MessageCircle, Shield, CalendarCheck, X, ExternalLink, ChevronLeft, ChevronRight, Clock, Video, Globe, Check, UserPlus, Plus, PenLine, CheckCircle2 } from "lucide-react";
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isBefore, isToday, isSameDay, isSameMonth, startOfDay } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import { parseApiError } from "@/lib/api-error";

export interface MatchCard {
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
  country?: string;
}

// A doctor recommendation card. Carries the full canonical enriched doctor
// shape resolved server-side (DB-truth), plus the AI's match reasons and the
// success-rate context so the card renders the right clinic rate.
export interface DoctorCard extends DoctorCardData {
  reasons?: string[];
  eggSource?: string;
  ageGroup?: string;
  isNewPatient?: boolean;
}

// A side-by-side comparison card resolved server-side (DB-truth) for 2-4
// entities of the same type (clinics, donors, surrogates, doctors, agencies).
// Data-driven: one ComparisonCard renders any entity type via its grouped rows.
export interface ComparisonCardCellValue {
  display: string;
  best?: boolean;
}
export interface ComparisonCardData {
  entityType: string;
  title?: string;
  dimensions?: string[] | "all";
  entities: { id: string; name: string; photo?: string | null; subtitle?: string | null }[];
  groups: {
    key: string;
    label: string;
    rows: { label: string; values: ComparisonCardCellValue[] }[];
  }[];
}

export interface ConsultationCardData {
  providerId: string;
  /**
   * Set INSTEAD of providerId on an admin-sent calendar card - an admin sharing
   * their own calendar into a session has no provider to key on. The field was
   * always present in the data (server/chat-router.ts scans stored cards for it
   * when collecting a session's bookings); only this interface was missing it,
   * so the three client reads that match a booking to its card were type errors
   * that never surfaced, because the build strips types without checking them.
   */
  providerUserId?: string;
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

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  quickReplies?: string[];
  multiSelect?: boolean;
  matchCards?: MatchCard[];
  doctorCards?: DoctorCard[];
  comparisonCards?: ComparisonCardData[];
  prepDoc?: boolean;
  /** One-time "add your partner" offer attached by the server (uiCardData.partnerInvite). */
  partnerInvite?: { offered: boolean; asked?: boolean; form?: boolean };
  /** A question Eva sent to the agency on this turn (uiCardData.whisper); status flips when they answer. */
  whisper?: { queryId: string; providerLabel?: string; status: "pending" | "answered" };
  /** The concierge's one-time welcome to an invited member (uiCardData.memberWelcome). */
  memberWelcome?: { userId: string };
  consultationCard?: ConsultationCardData;
  /** Hydrated Booking objects for existing-meeting questions (join/reschedule/cancel). */
  meetingCards?: any[];
  agreementCard?: { agreementId: string; status: string; viewUrl: string | null };
  senderType?: string;
  senderName?: string;
  uiCardType?: string;
  uiCardData?: any;
  deliveredAt?: string | null;
  readAt?: string | null;
  createdAt?: string;
}

// Render a single line of AI/chat text: **bold** plus clickable links. The AI
// sometimes emits a join link (a full URL or an in-app /room/<id> path), often
// wrapped in `backticks` - this makes those clickable and strips the code
// backticks (the bubble does not support markdown code spans).

// The first chip of a binary quick reply gets the positive styling, but the
// thumbs-up icon only belongs on chips that actually say yes. "Find me a better
// match" is the first option yet it declines the profile, so a thumbs-up reads
// as sarcasm. Only affirmatives get the icon.
export function isAffirmativeReply(text: string): boolean {
  return /^\s*(yes\b|yeah\b|yep\b|yup\b|sure\b|ok\b|okay\b|absolutely\b|definitely\b|of course\b|sounds good\b|sounds great\b|makes sense\b|got it\b|perfect\b|great\b|i understand\b|i'?m ready\b|i do\b|let'?s\b|please do\b|that works\b|works for me\b|confirm\b)/i.test(text);
}

export function chatDateLabel(dateStr: string): string {
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

export const WORKING_CURATION_ID = "working-curation";

export const PREP_DOC_SECTIONS = [
  { icon: Heart, title: "Personal & Lifestyle", items: ["Family background & motivation", "Daily life & support system", "Work schedule"] },
  { icon: Brain, title: "Values & Boundaries", items: ["Relationship expectations", "Level of involvement during pregnancy"] },
  { icon: Stethoscope, title: "Medical & Pregnancy", items: ["Past pregnancy history", "Embryo transfer preferences", "Openness to twins"] },
  { icon: MessageCircle, title: "Ethical Topics", items: ["Views on termination if medically advised", "Personal/religious considerations"] },
  { icon: Shield, title: "Legal & Communication", items: ["Prior surrogacy experience", "Preferred communication style"] },
];


// One meeting/booking card - the SAME component serves the chat transcript
// AND the voice-call takeover (extracted from the message-list JSX so voice
// mode never forks it; slug comes from each booking's OWN provider so the
// reschedule picker hits the right calendar).
export function MeetingBookingCard({ booking, brandColor }: { booking: any; brandColor: string }) {
  return (
    <div
      className="w-full overflow-hidden border border-border bg-card"
      style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <CalendarCheck className="w-4 h-4 text-primary-foreground" />
          <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
            {`Meeting with ${booking.providerUser?.provider?.name || booking.providerUser?.name || "Provider"}`}
          </span>
        </div>
      </div>
      <div className="px-4 pb-4">
        <InlineBookingCalendar
          slug={booking.providerUser?.scheduleConfig?.bookingPageSlug || "__none__"}
          memberName={booking.providerUser?.name || "Provider"}
          brandColor={brandColor}
          existingBooking={booking}
        />
      </div>
    </div>
  );
}

export function PrepDocCard({ brandColor }: { brandColor: string }) {
  return (
    <Card
      className="overflow-hidden max-w-sm motion-safe:animate-[slideUp_0.4s_ease-out_forwards]"
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
        <p className="t-helper">
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
                    <li key={j} className="t-helper flex items-start gap-1.5">
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
            href="/api/knowledge/concierge-assets/match_call_prep_guide/file"
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
        <p className="t-helper italic">
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

export function AgreementSignCard({ card, brandColor, createdAt }: { card: { agreementId: string; status: string; viewUrl: string | null }; brandColor: string; createdAt?: string }) {
  const navigate = useNavigate();
  return (
    <Card
      className="overflow-hidden max-w-sm motion-safe:animate-[slideUp_0.4s_ease-out_forwards]"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <FileText className="w-4 h-4 text-primary-foreground" />
          <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">Agreement Ready to Sign</span>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="t-helper">
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
          <p className="t-helper italic">Check your email for the signing link.</p>
        )}
        {createdAt && (
          <div className="flex justify-end">
            <span style={{ fontSize: "var(--chat-timestamp-font-size, 11px)", lineHeight: "16px", opacity: "var(--chat-timestamp-opacity, 0.55)" as unknown as number }} className="whitespace-nowrap select-none">
              {new Date(createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

export function generateCalendarDays(month: Date) {
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

export function formatTime12(time24: string): string {
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
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
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
      } else {
        // A silently swallowed failure here reads to the user as a dead button.
        const body = await res.json().catch(() => null);
        setError(body?.message || "We could not move this meeting. Please try another time.");
      }
    } catch {
      setError("We could not move this meeting. Please check your connection and try again.");
    } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-3">
      <div className="t-helper grid grid-cols-7 text-center font-medium">
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
      {error && (
        <p className="text-xs text-destructive" data-testid="text-reschedule-picker-error">{error}</p>
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

export function BookingForm({
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
  const [editingContact, setEditingContact] = useState<boolean>(!(name && email));
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
        className="t-helper flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
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
        {/* Name, email and phone are already on file: show them as one line
            with Edit instead of re-asking (principle 3: nothing the parent
            told us is asked again). The fields open only when something is
            missing or the parent wants to change it. */}
        {!editingContact && name && email ? (
          <div className="flex items-start justify-between gap-3 bg-secondary rounded-[var(--container-radius)] px-3 py-2.5" data-testid="booking-contact-summary">
            <div className="min-w-0">
              <p className="t-micro-label">Booking as</p>
              <p className="t-micro-value truncate">{name}</p>
              <p className="t-helper truncate">{email}{phone ? ` · ${phone}` : ""}</p>
            </div>
            <button type="button" onClick={() => setEditingContact(true)} className="t-helper font-medium shrink-0 min-h-11 md:min-h-0 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md" style={{ color: "hsl(var(--primary))" }} data-testid="button-edit-contact">
              Edit
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <Label htmlFor="book-name-inline" className="t-form-label-sm">Name *</Label>
                <Input id="book-name-inline" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required className="h-11 text-base md:h-9 md:text-sm" data-testid="input-book-name-inline" />
              </div>
              <div className="space-y-0.5">
                <Label htmlFor="book-email-inline" className="t-form-label-sm">Email *</Label>
                <Input id="book-email-inline" autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 text-base md:h-9 md:text-sm" data-testid="input-book-email-inline" />
              </div>
            </div>
            <div className="space-y-0.5">
              <Label htmlFor="book-phone-inline" className="t-form-label-sm">Phone</Label>
              <Input id="book-phone-inline" autoComplete="tel" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-11 text-base md:h-9 md:text-sm" data-testid="input-book-phone-inline" />
            </div>
          </>
        )}

        <div className="space-y-1.5">
          {additionalAttendees.length > 0 && !showAttendeeFields && (
            <div className="space-y-1">
              {additionalAttendees.map((ae) => (
                <div key={ae.email} className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-[var(--radius)] px-2 py-1.5" data-testid={`attendee-chip-inline-${ae.email}`}>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{ae.name || ae.email}</p>
                    {ae.name && <p className="t-helper truncate">{ae.email}</p>}
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
              <Label className="flex items-center gap-1.5 t-form-label-sm"><UserPlus className="w-3 h-3" />Additional Attendees</Label>
              {additionalAttendees.length > 0 && (
                <div className="space-y-1">
                  {additionalAttendees.map((ae) => (
                    <div key={ae.email} className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-[var(--radius)] px-2 py-1.5" data-testid={`attendee-chip-inline-${ae.email}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{ae.name || ae.email}</p>
                        {ae.name && <p className="t-helper truncate">{ae.email}</p>}
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
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAttendeeFields(false)} className="t-helper h-7 flex-1" data-testid="button-close-attendee-fields-inline">Done</Button>
              </div>
            </div>
          )}
        </div>

        {!showNotes ? (
          <button type="button" onClick={() => setShowNotes(true)} className="t-helper flex items-center gap-1.5 hover:text-foreground transition-colors">
            <Plus className="w-3 h-3" />
            Add notes (optional)
          </button>
        ) : (
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-xs resize-none" placeholder="Anything you'd like to share..." data-testid="input-book-notes-inline" />
        )}

        {bookMutation.isError && (
          // The consultation focus lock and the preliminary-step gate both 409
          // with a structured body, so unwrap it rather than printing raw JSON.
          <p className="text-xs text-destructive">{parseApiError(bookMutation.error).message}</p>
        )}
                {/* Booking is the consent moment: the provider sees who the parent is
            from here on. Say so before the button, not after. */}
        <p className="t-helper mb-2" data-testid="text-booking-consent">
          Confirming shares your name, email and phone with the provider so they can prepare for the call. They confirm the time next, and you get an email as soon as they do.
        </p>
        <Button
          type="submit"
          className="w-full h-11 md:h-10 rounded-full text-sm font-semibold text-primary-foreground"
          style={{ backgroundColor: brandColor }}
          disabled={bookMutation.isPending}
          data-testid="button-confirm-booking-inline"
        >
          {bookMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm booking"}
        </Button>
      </form>
    </div>
  );
}

export function RescheduleDateSlots({
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
        <p className="t-helper text-center py-2">No available slots</p>
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
  prefill,
}: {
  slug: string;
  memberName: string;
  brandColor: string;
  existingBooking?: any;
  consultationMeta?: { aiSessionId?: string; matchmakerId?: string | null; profileLabel?: string | null; profilePhotoUrl?: string | null; providerId?: string; subjectProfileId?: string | null; subjectType?: string | null; meetingSubtype?: string | null };
  autoResetOnCancel?: boolean;
  showCalendarOnExpiry?: boolean;
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null; booking?: any }) => void;
  /** When provided, the form fields are pre-populated with this contact info instead of the logged-in user's. Used by admin to book on behalf of a parent. */
  prefill?: { name: string; email: string; phone?: string };
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
  const [name, setName] = useState(prefill?.name ?? (user ? (user as any).name || "" : ""));
  const [email, setEmail] = useState(prefill?.email ?? (user ? (user as any).email || "" : ""));
  const [phone, setPhone] = useState(prefill?.phone ?? (user ? (user as any).mobileNumber || "" : ""));
  const [notes, setNotes] = useState("");
  const [additionalAttendees, setAdditionalAttendees] = useState<{ email: string; name: string; phone: string }[]>([]);
  const [showAttendeeFields, setShowAttendeeFields] = useState(false);
  // The other members of the family account (a partner) are pre-filled as
  // attendees: the confirmation card already lists them as participants, and
  // an invited partner should not depend on the owner remembering to add
  // them to the one call they both need to attend. Removable with one tap.
  const { data: accountMembers } = useQuery<{ id: string; name?: string | null; email?: string | null; mobileNumber?: string | null; parentAccountRole?: string | null }[]>({
    queryKey: ["/api/parent-account/members"],
    enabled: !!user && !existingBookingProp,
    staleTime: 60_000,
  });
  const attendeesPrefilledRef = useRef(false);
  useEffect(() => {
    if (attendeesPrefilledRef.current || !Array.isArray(accountMembers) || !user) return;
    const myEmail = String((user as any).email || "").toLowerCase();
    const others = accountMembers
      .filter((m) => m.email && m.email.toLowerCase() !== myEmail && m.id !== (user as any).id)
      .map((m) => ({ email: m.email as string, name: m.name || "", phone: m.mobileNumber || "" }));
    attendeesPrefilledRef.current = true;
    if (others.length > 0) {
      setAdditionalAttendees((prev) => prev.length ? prev : others);
      setShowAttendeeFields(true);
    }
  }, [accountMembers, user]);
  const [newAttendeeEmail, setNewAttendeeEmail] = useState("");
  const [newAttendeeName, setNewAttendeeName] = useState("");
  const [newAttendeePhone, setNewAttendeePhone] = useState("");
  const [booking, setBooking] = useState<any>(existingBookingProp || null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
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
  const [bookerTimezone, setBookerTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  // A parent who connected a calendar for conflict checking only sees times
  // they are actually free. The public /book page did this and chat did not;
  // both run through this component now.
  const userRoles: string[] = user ? ((user as any).roles || []) : [];
  const isParentBooker = userRoles.includes("PARENT") && userRoles.length === 1 && !prefill;
  const { data: parentConnections } = useQuery<any[]>({
    queryKey: ["/api/calendar/connections", "parent-booking"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/connections", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isParentBooker,
    staleTime: 5 * 60_000,
  });
  const conflictParentId = isParentBooker && parentConnections?.some((c: any) => c.isConflictCalendar && c.connected) ? (user as any).id : null;
  const conflictParam = conflictParentId ? `&parentUserId=${encodeURIComponent(conflictParentId)}` : "";

  const { data: availabilityDays } = useQuery<{ availableDays: number[] }>({
    queryKey: ["/api/calendar/availability-days", slug, monthStr, bookerTimezone, conflictParentId],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/availability-days/${slug}?month=${monthStr}&timezone=${bookerTimezone}${conflictParam}`, { credentials: "include" });
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

  // Phase 4: soft warning when the parent doesn't meet the clinic's matching
  // requirements (IVF clinics only - everyone else passes automatically).
  // Never blocks the booking; clinics make exceptions.
  const { data: requirementsCheck } = useQuery<{ pass: boolean; failed: string[] }>({
    queryKey: ["/api/providers/marketplace/clinics/requirements-check", consultationMeta?.providerId],
    queryFn: async () => {
      const r = await fetch(`/api/providers/marketplace/clinics/${consultationMeta!.providerId}/requirements-check`, { credentials: "include" });
      return r.ok ? r.json() : { pass: true, failed: [] };
    },
    enabled: !!consultationMeta?.providerId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: availability, isLoading: slotsLoading } = useQuery({
    queryKey: ["/api/calendar/availability", slug, dateStr, bookerTimezone, conflictParentId],
    queryFn: async () => {
      if (!dateStr) return null;
      const res = await fetch(`/api/calendar/availability/${slug}?date=${dateStr}&timezone=${bookerTimezone}${conflictParam}`, { credentials: "include" });
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
      if (consultationMeta?.meetingSubtype) {
        // Phase 4: Match Call / Doctor Call bookings carry a subtype that
        // gates the post-call readiness prompt + the 24h surrogate hold.
        body.meetingSubtype = consultationMeta.meetingSubtype;
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
        onBookingConfirmed?.({ providerId: consultationMeta?.providerId, subjectProfileId: consultationMeta?.subjectProfileId, booking: data });
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

    // Display branch - shared with provider/admin via InlineBookingNotification.
    // `embedded` skips the outer wrapper since the parent timeline already provides
    // the brand-color header + card border (see line ~4470).
    return (
      <InlineBookingNotification
        booking={booking}
        brandColor={brandColor}
        viewerRole="parent"
        embedded
        onUpdate={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/chat-session"] });
          queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
        }}
        onRequestReschedule={() => {
          setSelectedDate(null);
          setSelectedSlot(null);
          setCurrentMonth(new Date());
          setStep("reschedule");
        }}
        onRequestCancel={() => setStep("cancel_confirm")}
      />
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
          <p className="t-helper">Your consultation with {providerName} will be cancelled and all participants will be notified.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setCancelError(null); setStep("pending"); }}
            className="flex-1 text-center text-sm font-medium min-h-11 rounded-[var(--radius)] border border-border hover:bg-muted transition-colors cursor-pointer"
            data-testid="btn-cancel-keep"
          >
            Keep meeting
          </button>
          <button
            onClick={async () => {
              setCancelling(true);
              setCancelError(null);
              // A failed cancel used to do nothing at all, leaving the parent
              // to guess whether the meeting was still on. Say so.
              try {
                const res = await fetch(`/api/calendar/booking/${booking.publicToken}/cancel-public`, { method: "POST", credentials: "include" });
                if (res.ok) {
                  setBooking({ ...booking, status: "CANCELLED" });
                  setStep("cancelled");
                  queryClient.invalidateQueries({ queryKey: ["/api/chat-session"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
                } else {
                  const data = await res.json().catch(() => null);
                  setCancelError(data?.message || "We couldn't cancel it just now. Your meeting is still booked - try again in a moment.");
                }
              } catch {
                setCancelError("We couldn't reach the server. Your meeting is still booked - check your connection and try again.");
              } finally { setCancelling(false); }
            }}
            disabled={cancelling}
            className="flex-1 text-center text-sm font-medium min-h-11 rounded-[var(--radius)] bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50"
            data-testid="btn-cancel-confirm"
          >
            {cancelling ? "Cancelling..." : "Yes, cancel"}
          </button>
        </div>
        {cancelError && <p className="text-sm text-destructive text-center" role="alert">{cancelError}</p>}
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
          <p className="font-bold text-sm">Meeting cancelled</p>
        </div>
        <p className="t-helper text-center">This meeting has been cancelled and all participants have been notified.</p>
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
          className="t-helper flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
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
      <div className="t-helper flex items-center gap-2">
        <Clock className="w-3.5 h-3.5" />
        <span>{pageInfo?.meetingDuration || 30} min</span>
        <span className="mx-1">·</span>
        <Video className="w-3.5 h-3.5" />
        <span>Video call</span>
      </div>

      {/* Phase 4: soft heads-up when the parent may not meet the clinic's
          matching requirements. Informational only - booking stays open. */}
      {requirementsCheck && !requirementsCheck.pass && (
        <div
          className="rounded-[var(--radius)] border px-3 py-2.5 text-xs leading-relaxed"
          style={{
            borderColor: "hsl(var(--brand-warning) / 0.4)",
            background: "hsl(var(--brand-warning) / 0.08)",
            color: "hsl(var(--foreground))",
          }}
          data-testid="requirements-warning"
        >
          <span className="font-semibold" style={{ color: "hsl(var(--brand-warning))" }}>Heads up:</span>{" "}
          based on your profile, this clinic {requirementsCheck.failed.join("; ")}. Clinics sometimes make
          exceptions, so you're welcome to book anyway - or ask me in the chat for clinics that match your profile.
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            aria-label="Previous month"
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            data-testid="button-prev-month-inline"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-semibold" aria-live="polite">{format(currentMonth, "MMMM yyyy")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            aria-label="Next month"
            onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            data-testid="button-next-month-inline"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <TimezonePicker value={bookerTimezone} onChange={setBookerTimezone} idPrefix={`tz-${slug}`} />
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="text-[12px] font-medium text-muted-foreground py-1 uppercase">{d}</div>
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
                aria-label={format(day.date, "EEEE, MMMM d")}
                aria-pressed={!!isSelected}
                className={`relative w-10 h-10 md:w-8 md:h-8 rounded-full text-sm md:text-xs transition-all mx-auto flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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

export function SelectedDateSlots({
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
        <p className="t-helper text-center py-3">No available times on this date.</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {availability?.slots?.map((slot: any) => (
            <button
              key={slot.time}
              onClick={() => onSelectSlot(slot.time)}
              className="px-2 py-2 min-h-11 md:min-h-0 rounded-full text-sm md:text-xs font-medium transition-all cursor-pointer bg-secondary border border-border [@media(hover:hover)]:hover:bg-primary/10 [@media(hover:hover)]:hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground/80"
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

export function ConsultationBookingCard({
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
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null; booking?: any }) => void;
}) {
  const [callbackExpanded, setCallbackExpanded] = useState(true);
  const [callbackName, setCallbackName] = useState(userName || "");
  const [callbackEmail, setCallbackEmail] = useState(userEmail || "");
  const [callbackMessage, setCallbackMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [callbackError, setCallbackError] = useState("");
  // The booking the inline calendar just made. The header used to wait for
  // the chat page's session-bookings list to catch up, so for a while it
  // kept saying "Schedule with..." above an "Awaiting confirmation" card.
  const [justBooked, setJustBooked] = useState<any>(null);
  const shownBooking = existingBooking || justBooked;
  // Booking is the reveal: the masked "the Egg Donor's Agency" gives way to
  // the organisation the parent is now actually talking to.
  const bookedOrg = shownBooking?.providerUser?.provider?.name || card.providerName;

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
        className="w-full motion-safe:animate-[slideUp_0.4s_ease-out_forwards] overflow-hidden border border-border bg-card"
        style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 540px)" }}
        data-testid="consultation-booking-card"
      >
        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <CalendarCheck className="w-4 h-4 text-primary-foreground" />
            <span className="text-primary-foreground text-sm font-semibold">
              {shownBooking && shownBooking.status !== "CANCELLED"
                ? card.providerName === "GoStork"
                  ? `GoStork Concierge Call with ${card.memberName || "GoStork Team"}`
                  : ((shownBooking as any).meetingSubtype ?? (card as any).meetingSubtype) === "MATCH_CALL"
                    ? `Match Call with ${card.memberName ? `${card.memberName} at ${bookedOrg}` : bookedOrg || "Consultant"}`
                    : ((shownBooking as any).meetingSubtype ?? (card as any).meetingSubtype) === "DOCTOR_CONSULTATION"
                      ? `Doctor Call with ${card.memberName ? `${card.memberName} at ${bookedOrg}` : bookedOrg || "Consultant"}`
                      : `Consultation with ${card.memberName ? `${card.memberName} at ${bookedOrg}` : bookedOrg || "Consultant"}`
                : card.providerName === "GoStork"
                  ? `Schedule GoStork Concierge Call with ${card.memberName || "GoStork Team"}`
                  : (card as any).meetingSubtype === "MATCH_CALL"
                    ? `Schedule your Match Call with ${card.memberName || card.providerName || "Consultant"}`
                    : (card as any).meetingSubtype === "DOCTOR_CONSULTATION"
                      ? `Schedule your Doctor Call with ${card.memberName || card.providerName || "Consultant"}`
                      : `Schedule with ${card.memberName ? `${card.memberName}${card.providerName ? ` at ${card.providerName}` : ""}` : (card.providerName || "Consultant")}`}
            </span>
          </div>
        </div>
        <div className="px-4 pb-4">
          <InlineBookingCalendar
            slug={card.memberBookingSlug}
            memberName={card.memberName || card.providerName}
            brandColor={brandColor}
            existingBooking={existingBooking}
            consultationMeta={{ aiSessionId: card.aiSessionId, matchmakerId: card.matchmakerId, profileLabel: card.profileLabel, profilePhotoUrl: card.profilePhotoUrl, providerId: card.providerId, subjectProfileId: card.subjectProfileId, subjectType: card.subjectType, meetingSubtype: (card as any).meetingSubtype ?? null }}
            onBookingConfirmed={(meta) => { if (meta.booking) setJustBooked(meta.booking); onBookingConfirmed?.(meta); }}
          />
        </div>
      </div>
    );
  }

  return (
    <Card
      className="overflow-hidden max-w-sm motion-safe:animate-[slideUp_0.4s_ease-out_forwards]"
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
              className="w-12 h-12 rounded-full object-contain p-1 bg-background border-2"
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
            <p className="t-helper">Ready to connect</p>
          </div>
        </div>
        <p className="t-helper mb-4">
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
            <p className="t-helper">
              {card.providerName} will reach out to schedule your consultation.
            </p>
          </div>
        ) : callbackExpanded ? (
          <form onSubmit={handleCallbackSubmit} className="space-y-3 mt-1">
            <div className="space-y-1.5">
              <Label className="t-form-label-sm">Your Name</Label>
              <Input
                value={callbackName}
                onChange={e => setCallbackName(e.target.value)}
                required
                data-testid="input-callback-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="t-form-label-sm">Email</Label>
              <Input
                type="email"
                value={callbackEmail}
                onChange={e => setCallbackEmail(e.target.value)}
                required
                data-testid="input-callback-email"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="t-form-label-sm">Message (optional)</Label>
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

export function BookingOverlay({
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
            <p className="t-helper max-w-md">
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
            <p className="t-helper max-w-md">
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
            <p className="t-helper">
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

export function buildMatchTabs(profile: any, cardType: string, reasons: string[] = []): TabSection[] {
  reasons = reasons || [];
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
    // "Based in USA" is trivially true when the only geography answer was
    // USA; keep it, but let the reasons that discriminate lead.
    const ordered = [...reasons].sort((a, b) => Number(/^based in/i.test(a)) - Number(/^based in/i.test(b)))
      .map((r) => r.replace(/^Based in USA$/i, "Based in the USA"));
    const matchTab: TabSection = {
      layoutType: "matched_bubbles",
      title: `Matches ${reasons.length} of your preference${reasons.length !== 1 ? "s" : ""}`,
      items: ordered.map(r => ({ label: r, value: "" })),
    };
    return [matchTab, ...baseTabs];
  }

  return baseTabs;
}

// Actually persist a favorite when the parent taps the heart on an in-chat
// match card. Previously the heart only sent a "Save as favorite" message and
// the AI *claimed* it saved - nothing was written, so the Saved page stayed
// empty. This writes to the same endpoints the marketplace uses, so chat saves
// show up in Saved (and count toward sponsorship "Saves"). Donors/surrogates/
// sperm share /donor-preferences; clinics/doctors/agencies use /profile-preferences.
// Ids saved from chat in this session, so the card can wear its "Saved"
// badge the moment the chip is tapped (the hidden heart button used to be
// the only saved-state UI, and chat hides it).
export const chatSavedIds = new Set<string>();
export const chatSavedListeners = new Set<() => void>();
export function subscribeChatSaved(cb: () => void) { chatSavedListeners.add(cb); return () => { chatSavedListeners.delete(cb); }; }
export function useChatSaved(id?: string | null): boolean {
  return useSyncExternalStore(subscribeChatSaved, () => !!id && chatSavedIds.has(id), () => false);
}
export function persistChatFavorite(kind: "donor" | "clinic" | "doctor" | "agency", id?: string | null) {
  if (!id) return;
  chatSavedIds.add(id);
  chatSavedListeners.forEach((cb) => cb());
  const url = kind === "donor"
    ? `/api/donor-preferences/favorite/${id}`
    : `/api/profile-preferences/${kind}/favorite/${id}`;
  fetch(url, { method: "POST", credentials: "include" }).catch(() => {});
}

export function ClinicMatchCard({ card, brandColor, onAction, onViewProfile }: { card: MatchCard; brandColor: string; onAction: (text: string) => void; onViewProfile: (card: MatchCard) => void }) {
  const navigate = useNavigate();
  const clinicName = card.name || "this clinic";

  const providerUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (card.eggSource) params.set("eggSource", card.eggSource);
    if (card.ageGroup) params.set("ageGroup", card.ageGroup);
    if (card.isNewPatient !== undefined) params.set("isNewPatient", String(card.isNewPatient));
    const qs = params.toString();
    return `/providers/${card.providerId}${qs ? `?${qs}` : ""}`;
  }, [card.providerId, card.eggSource, card.ageGroup, card.isNewPatient]);

  const goToProfile = () => navigate(providerUrl, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } });

  // The card itself is the SHARED ClinicSwipeCard (same component the marketplace
  // IVF Clinics deck uses); the matcher just adds chat actions + footer buttons.
  return (
    <div className="w-full" data-testid={`match-card-${card.providerId}`}>
      <div className="w-full aspect-[5/8] sm:aspect-[3/4] overflow-hidden motion-safe:animate-[slideUp_0.4s_ease-out_forwards]">
        <ClinicSwipeCard
          providerId={card.providerId}
          eggSource={card.eggSource}
          ageGroup={card.ageGroup}
          isNewPatient={card.isNewPatient}
          reasons={card.reasons || []}
          disableSwipe
          chatMode
          onPass={() => onAction(`I'm not interested in ${clinicName}. Show me another option.`)}
          onSave={() => { persistChatFavorite("clinic", card.providerId); onAction(`I like ${clinicName}! Save as favorite. ❤️`); }}
          onViewProfile={goToProfile}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" className="flex-1 text-xs font-ui h-8" onClick={goToProfile}>
          View Details
        </Button>
        <Button className="flex-1 text-xs font-ui h-8 text-primary-foreground" style={{ backgroundColor: brandColor }} onClick={() => onAction(`I'd like to schedule a consultation with ${clinicName}`)}>
          Schedule Consultation
        </Button>
      </div>
    </div>
  );
}

// Doctor recommendation card. Reuses the SAME SwipeDeckCard shell + design as
// the clinic card's doctor-face tabs (face hero, name + clinic logo/location/
// badge pinned at top); only the tab CONTENT differs (built by getDoctorTabs).
// The full enriched doctor is resolved server-side and arrives on `card`, so no
// extra fetch is needed (unlike ClinicMatchCard, which hydrates from the
// provider endpoint). Whisper/booking route through the doctor's clinic.
export function DoctorMatchCard({ card, brandColor, onAction }: { card: DoctorCard; brandColor: string; onAction: (text: string) => void }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // Success-rate context (drives which clinic rate the tab shows), matching the
  // clinic card. Falls back to marketplace defaults.
  const eggSource = card.eggSource || "own_eggs";
  const ageGroup = card.ageGroup || "under_35";
  const isNew = card.isNewPatient !== undefined ? card.isNewPatient : true;
  const ageLabel = ageGroup === "under_35" ? "Under 35" : ageGroup === "35_37" ? "35-37" : ageGroup === "38_40" ? "38-40" : "Over 40";
  const contextLabel = eggSource === "donor" ? "Donor eggs" : ["Own eggs", ageLabel, isNew ? "First-time IVF" : "Prior cycles"].join(" · ");

  // Shared card-prop assembly so the marketplace deck and this chat card match.
  const { photos, photoLabels, logoSrc, primary, successBadge, tabs, headerLocation, firstSlidePlain } = buildDoctorCardProps(card, {
    reasons: card.reasons || card.matchedReasons || [],
    contextLabel,
    compact: isMobile,
  });

  // Forward the same context the badge above was computed from - the clinic card
  // in this file already does (providerUrl). Without it the card could show
  // "Top 10%" and the profile it opens could not.
  const doctorUrl = `/doctors/${card.slug}${ivfContextSearch({ eggSource, ageGroup, isNewPatient: String(isNew) })}`;
  const goToProfile = () => navigate(doctorUrl, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } });
  const clinicName = primary?.providerName || "their clinic";

  // Eva surfacing a doctor card in chat is an impression (keyed by slug, like
  // the marketplace doctor deck and analytics).
  useEffect(() => {
    if (card.slug) recordImpression(card.slug, "doctor");
  }, [card.slug]);

  return (
    <div className="w-full" data-testid={`doctor-card-${card.slug}`}>
      <div className="w-full aspect-[5/7] sm:aspect-[3/4] overflow-hidden motion-safe:animate-[slideUp_0.4s_ease-out_forwards]">
        <SwipeDeckCard
          id={card.slug}
          photos={photos}
          photoLabels={photoLabels}
          title={card.name}
          pinnedHeader={{ logoUrl: logoSrc, title: card.name, location: headerLocation, badge: successBadge }}
          monogramName={card.name}
          firstSlidePlain={firstSlidePlain}
          tabs={tabs}
          disableSwipe
          chatMode
          onPass={() => onAction(`I'm not interested in ${card.name}. Show me another doctor.`)}
          onSave={() => { persistChatFavorite("doctor", card.slug); onAction(`I like ${card.name}! Save as favorite. ❤️`); }}
          onViewFullProfile={goToProfile}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" className="flex-1 text-xs font-ui h-8" onClick={goToProfile}>
          View Profile
        </Button>
        <Button className="flex-1 text-xs font-ui h-8 text-primary-foreground" style={{ backgroundColor: brandColor }} onClick={() => onAction(`I'd like to schedule a consultation with ${card.name} at ${clinicName}`)}>
          Schedule Consultation
        </Button>
      </div>
    </div>
  );
}

// Part 4: international program card. One card per country (e.g. Mexico,
// Colombia) showing the COMBINED cost of the surrogacy agency + its partner
// IVF clinic(s) for this parent - apples-to-apples across countries. Cost is
// hydrated server-side (no AI math) from /country-program.
export function CountryProgramCard({ card, brandColor, onAction }: { card: MatchCard; brandColor: string; onAction: (text: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/costs/provider/${card.providerId}/country-program`, { credentials: "include" });
        if (res.ok) setData(await res.json());
        else setFailed(true);
      } catch {
        setFailed(true);
      }
    })();
  }, [card.providerId]);

  if (!data && !failed) {
    return (
      <div className="min-w-[320px] max-w-[420px] w-full rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const country = card.country || data?.country || card.location || "";
  const flag = getCountryFlag(country);
  const agencyName = data?.agencyName || card.name || "";
  const components: any[] = data?.components || [];
  const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const totalLabel = data
    ? (data.combinedMinTotal === data.combinedMaxTotal
        ? fmt(data.combinedMinTotal)
        : `${fmt(data.combinedMinTotal)} - ${fmt(data.combinedMaxTotal)}`)
    : null;
  const hasCost = data?.hasCost && components.length > 0;

  return (
    <div
      className="min-w-[320px] max-w-[420px] w-full motion-safe:animate-[slideUp_0.4s_ease-out_forwards] border border-[hsl(var(--brand-success))]/40 bg-card overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid={`country-program-card-${card.providerId}`}
      onClick={() => navigate(`/providers/${card.providerId}`, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } })}
    >
      {/* Header: country flag + name + Program pill */}
      <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {flag ? <span className="text-2xl" aria-hidden>{flag}</span> : <Globe className="w-5 h-5 text-muted-foreground shrink-0" />}
          <div className="min-w-0">
            <h3 className="font-heading text-xl text-foreground leading-tight">{country || agencyName}</h3>
            <p className="t-helper truncate">{agencyName}{country ? " program" : ""}</p>
          </div>
        </div>
        <Badge className="bg-secondary text-secondary-foreground border-secondary rounded-full shrink-0">Program</Badge>
      </div>

      {/* Combined total */}
      {hasCost && (
        <div className="px-5 pb-3">
          <p className="t-micro-label">Estimated all-in cost</p>
          <p className="text-3xl font-heading text-primary mt-1">{totalLabel}</p>
        </div>
      )}

      {/* Per-provider / per-service breakdown */}
      {hasCost && (
        <div className="border-t border-border/60 px-5 py-4 space-y-2">
          {components.map((c: any, i: number) => (
            <div key={i} className="flex items-start justify-between gap-3 text-sm">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <span className="text-foreground">{c.serviceLabel}</span>
                  {c.providerName && <span className="t-helper block truncate">via {c.providerName}</span>}
                </div>
              </div>
              <span className="tabular-nums text-foreground shrink-0">
                {c.minTotal === c.maxTotal ? fmt(c.minTotal) : `${fmt(c.minTotal)} - ${fmt(c.maxTotal)}`}
              </span>
            </div>
          ))}
          {data?.missingServices?.length > 0 && (
            <p className="t-helper italic pt-1">
              {data.missingServices.map((s: string) => s === "egg_donor" ? "egg donor" : s === "ivf_clinic" ? "IVF" : s).join(", ")} pricing available on consultation
            </p>
          )}
        </div>
      )}

      {/* Match reasons */}
      {card.reasons?.length > 0 && (
        <div className="px-5 pb-4 flex flex-wrap gap-1.5">
          {card.reasons.map((r) => (
            <span key={r} className="text-xs px-2 py-0.5 rounded-full border border-border bg-background text-foreground font-ui">
              {r}
            </span>
          ))}
        </div>
      )}

      {!hasCost && (
        <div className="px-5 pb-4">
          <p className="t-helper">Get a personalized all-in quote on a free consultation.</p>
        </div>
      )}

      <div className="border-t border-border/50 px-4 py-3 flex gap-2">
        <Button
          variant="outline"
          className="flex-1 text-xs font-ui h-8"
          onClick={(e) => { e.stopPropagation(); navigate(`/providers/${card.providerId}`, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } }); }}
        >
          View Program
        </Button>
        <Button
          className="flex-1 text-xs font-ui h-8 text-primary-foreground"
          style={{ backgroundColor: brandColor }}
          onClick={(e) => { e.stopPropagation(); onAction(`I'd like to schedule a consultation for the ${country || agencyName} program`); }}
        >
          Book Consultation
        </Button>
      </div>
    </div>
  );
}

// International surrogacy-agency match card. Now uses the SHARED AgencySwipeCard
// (same component the marketplace agencies deck renders), exactly like
// ClinicMatchCard uses the shared ClinicSwipeCard - the matcher just adds the
// chat actions + footer buttons. The richer agency content (babies born /
// time-to-match / screening / locations) lives in getAgencyTabs, so chat and
// marketplace stay identical.
export function AgencyMatchCard({ card, brandColor, onAction }: { card: MatchCard; brandColor: string; onAction: (text: string) => void }) {
  const navigate = useNavigate();
  const agencyName = card.name || "this agency";
  const goToProfile = () => navigate(`/providers/${card.providerId}`, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } });

  return (
    <div className="w-full" data-testid={`match-card-${card.providerId}`}>
      <div className="w-full aspect-[3/4] overflow-hidden motion-safe:animate-[slideUp_0.4s_ease-out_forwards]">
        <AgencySwipeCard
          providerId={card.providerId}
          reasons={card.reasons || []}
          disableSwipe
          chatMode
          onPass={() => onAction(`I'm not interested in ${agencyName}. Show me another option.`)}
          onSave={() => { persistChatFavorite("agency", card.providerId); onAction(`I like ${agencyName}! Save as favorite. ❤️`); }}
          onViewProfile={goToProfile}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" className="flex-1 text-xs font-ui h-8" onClick={goToProfile}>
          View Agency
        </Button>
        <Button className="flex-1 text-xs font-ui h-8 text-primary-foreground" style={{ backgroundColor: brandColor }} onClick={() => onAction(`I'd like to schedule a consultation with ${agencyName}`)}>
          Book Consultation
        </Button>
      </div>
    </div>
  );
}

// Law-firm match card - the SHARED LawGroupSwipeCard (firm tabs + one face
// tab per lawyer); the matcher adds the chat footer buttons. "Schedule a
// Call" routes through the deterministic lawyer-connect bypass, which opens
// the legal chat and embeds the attorney's booking calendar.
export function LawGroupMatchCard({ card, brandColor, onAction }: { card: MatchCard; brandColor: string; onAction: (text: string) => void }) {
  const navigate = useNavigate();
  const firmName = card.name || "this firm";
  const goToProfile = () => navigate(`/providers/${card.providerId}`, { state: { fromChat: true, chatPath: window.location.pathname + window.location.search } });

  return (
    <div className="w-full" data-testid={`match-card-${card.providerId}`}>
      <div className="w-full aspect-[3/4] overflow-hidden motion-safe:animate-[slideUp_0.4s_ease-out_forwards]">
        <LawGroupSwipeCard
          providerId={card.providerId}
          reasons={card.reasons || []}
          disableSwipe
          chatMode
          onPass={() => onAction(`I'm not interested in ${firmName}.`)}
          onSave={() => { persistChatFavorite("agency", card.providerId); onAction(`I like ${firmName}! Save as favorite. ❤️`); }}
          onViewProfile={goToProfile}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" className="flex-1 text-xs font-ui h-8" onClick={goToProfile}>
          View Firm
        </Button>
        <Button className="flex-1 text-xs font-ui h-8 text-primary-foreground" style={{ backgroundColor: brandColor }} onClick={() => onAction("Connect me with a lawyer")}>
          Schedule a Call
        </Button>
      </div>
    </div>
  );
}

// fill: size the card to its parent's full height (the voice panel's
// FaceTime profile takeover) instead of the chat column's 3:4 aspect box.
export function MatchCardComponent({ card, brandColor, onAction, onViewProfile, fill = false }: { card: MatchCard; brandColor: string; onAction: (text: string) => void; onViewProfile: (card: MatchCard) => void; fill?: boolean }) {
  const [profile, setProfile] = useState<any>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const cardType = card.type || "";
  const isClinic = cardType.toLowerCase() === "clinic";
  const isAgency = cardType.toLowerCase() === "surrogacyagency" || cardType.toLowerCase() === "surrogacy agency";
  const isCountryProgram = cardType.toLowerCase() === "countryprogram" || cardType.toLowerCase() === "country program";
  const isLawGroup = cardType.toLowerCase() === "law group" || cardType.toLowerCase() === "lawgroup" || cardType.toLowerCase() === "legal services";

  useEffect(() => {
    if (isClinic || isAgency || isCountryProgram || isLawGroup) return;
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
  }, [card.providerId, card.type, isClinic, isAgency, isCountryProgram, isLawGroup]);

  // Hooks must run unconditionally, BEFORE any early return below (clinic /
  // agency / loading branches). A photo-less card first renders the loading
  // branch and then re-renders with a profile; if these hooks sat after that
  // early return, the second render would call more hooks than the first
  // ("Rendered more hooks than during the previous render").
  const { viewedIds, previousVisitAt } = useMarketplaceViewContext();
  const savedHere = useChatSaved(card.providerId);
  const profileId = profile?.id;
  const profileTypeForView: "egg-donor" | "surrogate" | "sperm-donor" =
    cardType.toLowerCase() === "surrogate" ? "surrogate"
      : cardType.toLowerCase() === "sperm donor" ? "sperm-donor"
        : "egg-donor";
  // The moment the AI surfaces a MATCH_CARD in chat, count it as having shown
  // the parent this profile - so its "New" badge clears in marketplace views.
  useEffect(() => {
    if (profileId) recordProfileView(profileId, profileTypeForView);
  }, [profileId, profileTypeForView]);

  // Eva surfacing a profile card in chat is an impression (the profile was
  // shown to the parent). Keyed by the entity id (card.providerId) so it fires
  // immediately on mount, independent of the photo-profile fetch above. Covers
  // donors/surrogates/sperm AND clinics/agencies; country programs aren't a
  // single sponsorable profile, so they're skipped.
  useEffect(() => {
    const t = cardType.toLowerCase();
    if (t === "countryprogram" || t === "country program" || isLawGroup) return;
    const imprType = isClinic ? "clinic" : isAgency ? "agency"
      : t === "surrogate" ? "surrogate" : t === "sperm donor" ? "sperm-donor" : "egg-donor";
    if (card.providerId) recordImpression(card.providerId, imprType);
  }, [card.providerId, cardType, isClinic, isAgency, isLawGroup]);

  if (isClinic) {
    return <ClinicMatchCard card={card} brandColor={brandColor} onAction={onAction} onViewProfile={onViewProfile} />;
  }

  if (isLawGroup) {
    return <LawGroupMatchCard card={card} brandColor={brandColor} onAction={onAction} />;
  }

  if (isCountryProgram) {
    return <CountryProgramCard card={card} brandColor={brandColor} onAction={onAction} />;
  }

  if (isAgency) {
    return <AgencyMatchCard card={card} brandColor={brandColor} onAction={onAction} />;
  }

  if (!profile && !card.photo) {
    if (fetchFailed) {
      return (
        <div className="w-full rounded-[var(--container-radius)] overflow-hidden bg-muted border border-border p-4 text-center">
          <p className="t-helper font-ui">{card.name || cardType || "Profile"}</p>
          <p className="t-helper mt-1">This profile did not load.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 rounded-full"
            onClick={() => onAction("That profile didn't load for me. Could you show me another option?")}
            data-testid="btn-card-unavailable-another"
          >
            Ask for another
          </Button>
        </div>
      );
    }
    return (
      <div data-testid={`match-card-${card.providerId}`} className={`w-full ${fill ? "h-full" : "aspect-[3/4]"} rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center`}>
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
    const statusLabel = buildStatusLabel(swipeProfile, viewedIds, previousVisitAt);
    const tabs = buildMatchTabs(profile, card.type, card.reasons || []);

    return (
      <div
        // 4/5 on phones: with the chips under the card, 3/4 put the fourth
        // chip 44px below a 609px log; 4/5 brings the whole decision above
        // the fold.
        className={`w-full ${fill ? "h-full" : "aspect-[4/5] sm:aspect-[3/4]"} overflow-hidden motion-safe:animate-[slideUp_0.4s_ease-out_forwards]`}
        data-testid={`match-card-${card.providerId}`}
      >
        <SwipeDeckCard
          id={card.providerId}
          isSaved={savedHere || !!profile?.isFavorite || !!profile?.isFavorited}
          photos={photos}
          title={title}
          statusLabel={statusLabel}
          donorStatus={swipeProfile.donorStatus}
          onHoldUntil={swipeProfile.onHoldUntil ?? null}
          frozenLotStatus={swipeProfile.frozenLotStatus}
          isExperienced={swipeProfile.isExperienced}
          isPremium={swipeProfile.isPremium}
          sponsored={swipeProfile.sponsored}
          tabs={tabs}
          disableSwipe={!fill}
          chatMode
          hideActions
          onPass={() => onAction(`Not the right fit for us - show me someone else.`)}
          onSave={() => { persistChatFavorite("donor", card.providerId); onAction("Save as favorite"); }}
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
          <DoctorMonogram name={card.name} size={80} className="mb-4" />
          <h3 className="font-heading text-xl text-center leading-tight">{card.name}</h3>
          {card.location && <p className="t-helper mt-1">{formatLocationDisplay(card.location)}</p>}
        </div>
      )}
      {card.photo && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
          <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
          {card.location && <p className="text-white/70 text-sm mt-1">{formatLocationDisplay(card.location)}</p>}
        </div>
      )}
    </div>
  );
}


/**
 * Every inline card attached to one chat message, in the order the parent sees
 * them. Used by the parent chat (interactive) and by the shared ChatMessageList
 * for the admin monitor and the provider view (readOnly).
 *
 * Card data is read from the message's top-level fields when present (the
 * parent page maps them off uiCardData when it loads a session) and falls back
 * to uiCardData itself, so a raw DB row - which is exactly what the admin
 * endpoint returns - renders identically without any mapping step.
 */
export function ChatInlineCards({
  msg,
  allMessages = [],
  brandColor,
  placement,
  readOnly = false,
  onAction,
  onViewProfile,
  onSchedule,
  existingBookingFor,
  userEmail,
  userName,
  onCallbackSubmitted,
  onBookingConfirmed,
  afterMatchCards,
}: {
  msg: any;
  allMessages?: any[];
  brandColor: string;
  /** "above" renders the profile cards that sit over the text bubble, "below" the action cards under it. */
  placement: "above" | "below";
  readOnly?: boolean;
  onAction?: (text: string) => void;
  onViewProfile?: (card: MatchCard) => void;
  onSchedule?: (card: ConsultationCardData) => void;
  existingBookingFor?: (msg: any) => any;
  userEmail?: string;
  userName?: string;
  onCallbackSubmitted?: () => void;
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null; booking?: any }) => void;
  /** Slot rendered between the match cards and the doctor cards - the parent
   *  chat puts the quick-reply chips there, so the decision sits with the face. */
  afterMatchCards?: React.ReactNode;
}) {
  const extras = (msg?.uiCardData as any) || {};
  const pick = (key: string) => msg?.[key] ?? extras?.[key];
  const matchCards: MatchCard[] = pick("matchCards") || [];
  const doctorCards: DoctorCard[] = pick("doctorCards") || [];
  const comparisonCards: ComparisonCardData[] = pick("comparisonCards") || [];
  const meetingCards: any[] = pick("meetingCards") || [];
  const prepDoc = pick("prepDoc");
  const agreementCard = pick("agreementCard");
  const consultationCard: ConsultationCardData | undefined = pick("consultationCard");
  const noop = () => {};
  const act = readOnly ? noop : (onAction || noop);

  if (placement === "above") {
    if (!matchCards.length && !doctorCards.length && !comparisonCards.length && !afterMatchCards) return null;
    return (
      <>
        {matchCards.length > 0 && (
          <div className="mb-2 space-y-3 w-full max-w-[340px] sm:max-w-[380px]">
            {matchCards.map((card, ci) => (
              <MatchCardComponent
                key={ci}
                card={card}
                brandColor={brandColor}
                onAction={act}
                onViewProfile={readOnly ? noop : (onViewProfile || noop)}
              />
            ))}
          </div>
        )}
        {afterMatchCards}
        {doctorCards.length > 0 && (
          <div className="mb-2 space-y-3 w-full max-w-[340px] sm:max-w-[380px]">
            {doctorCards.map((card, ci) => (
              <DoctorMatchCard key={`doc-${ci}`} card={card} brandColor={brandColor} onAction={act} />
            ))}
          </div>
        )}
        {comparisonCards.length > 0 && (
          <div className="mb-2 space-y-3 w-full max-w-[460px] sm:max-w-[560px]">
            {comparisonCards.map((card, ci) => (
              <ComparisonCard key={`cmp-${ci}`} card={card} brandColor={brandColor} />
            ))}
          </div>
        )}
      </>
    );
  }

  // Only the LAST card for a given provider + call type renders: a Consultation
  // and a Match Call for the same provider are different meetings and both must
  // survive, but the same card repeated across turns must not stack up.
  let showConsultation = !!consultationCard;
  if (consultationCard && allMessages.length > 0) {
    const subtype = (consultationCard as any)?.meetingSubtype ?? null;
    const last = [...allMessages].reverse().find((m: any) => {
      const c = m?.consultationCard ?? m?.uiCardData?.consultationCard;
      return c != null
        && c?.providerId === (consultationCard as any)?.providerId
        && ((c as any)?.meetingSubtype ?? null) === subtype;
    });
    const mine = msg?.consultationCard ?? msg?.uiCardData?.consultationCard;
    if (last && (last?.consultationCard ?? last?.uiCardData?.consultationCard) !== mine) showConsultation = false;
  }

  if (!meetingCards.length && !prepDoc && !agreementCard && !showConsultation) return null;
  return (
    <>
      {meetingCards.length > 0 && (
        <div className="mt-3 space-y-3 w-full">
          {meetingCards.map((booking: any) => (
            <MeetingBookingCard key={`meeting-${booking.id}`} booking={booking} brandColor={brandColor} />
          ))}
        </div>
      )}
      {prepDoc && (
        <div className="mt-3"><PrepDocCard brandColor={brandColor} /></div>
      )}
      {agreementCard && (
        <div className="mt-3">
          {/* A watcher must never be able to open a signing session as the parent. */}
          <div className={readOnly ? "pointer-events-none" : undefined} aria-disabled={readOnly || undefined}>
            <AgreementSignCard card={agreementCard} brandColor={brandColor} createdAt={msg?.createdAt} />
          </div>
        </div>
      )}
      {showConsultation && consultationCard && (
        <div className="mt-3 w-full">
          {/* Same reasoning: the admin sees the calendar card the parent sees,
              but cannot book, submit a callback or cancel on her behalf. */}
          <div className={readOnly ? "pointer-events-none" : undefined} aria-disabled={readOnly || undefined}>
            <ConsultationBookingCard
              card={consultationCard}
              brandColor={brandColor}
              userEmail={userEmail || ""}
              userName={userName || ""}
              existingBooking={existingBookingFor ? existingBookingFor(msg) : undefined}
              onSchedule={readOnly ? noop : (onSchedule || noop)}
              onCallbackSubmitted={readOnly ? undefined : onCallbackSubmitted}
              onBookingConfirmed={readOnly ? undefined : onBookingConfirmed}
            />
          </div>
        </div>
      )}
    </>
  );
}
