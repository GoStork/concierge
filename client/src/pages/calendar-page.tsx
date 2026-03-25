import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Calendar as BigCalendar, dateFnsLocalizer, Views, DateLocalizer } from "react-big-calendar";
import type { NavigateAction, View } from "react-big-calendar";
import TimeGrid from "react-big-calendar/lib/TimeGrid";
import { format, parse, startOfWeek, getDay, startOfMonth, endOfMonth, addDays, subDays, isSameDay, isSameMonth, eachDayOfInterval } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useCompanyName } from "@/hooks/use-brand-settings";
import {
  Loader2, Plus, Copy, Check, Video, Clock, User, Users, Calendar, List, ChevronLeft, ChevronRight, X, Settings, CalendarClock, Phone, MapPin, Link2, Trash2, Pencil, FileText, Crown, Search, Filter, SlidersHorizontal, Repeat, CalendarCheck, Ban, ChevronDown,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import "react-big-calendar/lib/css/react-big-calendar.css";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

function MultiDayView(props: any) {
  const {
    date,
    localizer,
    min = localizer.startOf(new Date(), 'day'),
    max = localizer.endOf(new Date(), 'day'),
    scrollToTime = localizer.startOf(new Date(), 'day'),
    enableAutoScroll = true,
    ...rest
  } = props;
  return (
    <TimeGrid
      {...rest}
      date={date}
      localizer={localizer}
      min={min}
      max={max}
      scrollToTime={scrollToTime}
      enableAutoScroll={enableAutoScroll}
      range={MultiDayView.range(date)}
      eventOffset={10}
    />
  );
}
MultiDayView.range = (date: Date) => {
  return [date, addDays(date, 1)];
};
MultiDayView.navigate = (date: Date, action: NavigateAction) => {
  switch (action) {
    case "PREV": return subDays(date, 2);
    case "NEXT": return addDays(date, 2);
    default: return date;
  }
};
MultiDayView.title = (date: Date) => {
  const end = addDays(date, 1);
  return `${format(date, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
};

const MULTI_DAY_KEY = "multi_day";

const DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const calendarFormats = {
  timeGutterFormat: (date: Date) => {
    const h = date.getHours();
    if (h === 0) return "12 AM";
    if (h < 12) return `${h} AM`;
    if (h === 12) return "12 PM";
    return `${h - 12} PM`;
  },
  dayFormat: (date: Date) => `${date.getDate()} ${DAY_ABBR[date.getDay()]}`,
  weekdayFormat: (date: Date) => DAY_ABBR[date.getDay()],
};

type CalendarEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  type: "booking" | "block" | "external";
  resource?: any;
};

function CreateAppointmentDialog({ open, onClose, config }: { open: boolean; onClose: () => void; config: any }) {
  const { toast } = useToast();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [duration, setDuration] = useState(config?.meetingDuration || 30);
  const [subject, setSubject] = useState(config?.defaultSubject || "");
  const [attendees, setAttendees] = useState<{ name: string; email: string; phone: string }[]>([{ name: "", email: "", phone: "" }]);
  const [notes, setNotes] = useState("");
  const defaultVideoUrl = config?.meetingLink || config?.dailyRoomUrl || "";
  const [locationType, setLocationType] = useState<string>(defaultVideoUrl ? "custom_link" : "phone");
  const [locationValue, setLocationValue] = useState(defaultVideoUrl);
  const [phoneInfo, setPhoneInfo] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [showContacts, setShowContacts] = useState(false);
  const [activeAttendeeIdx, setActiveAttendeeIdx] = useState(0);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const { data: contacts } = useQuery<{ name: string; email: string; parentUserId?: string }[]>({
    queryKey: ["/api/calendar/contacts"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/contacts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const filteredContacts = useMemo(() => {
    if (!contacts) return [];
    const q = contactSearch.toLowerCase();
    const currentEmails = new Set(attendees.map((a) => a.email.toLowerCase()).filter(Boolean));
    return contacts.filter(
      (c) => !currentEmails.has(c.email.toLowerCase()) && (c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    );
  }, [contacts, contactSearch, attendees]);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/calendar/bookings", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Appointment created", variant: "success" });
      onClose();
      setDate("");
      setTime("09:00");
      setSubject(config?.defaultSubject || "");
      setAttendees([{ name: "", email: "", phone: "" }]);
      setNotes("");
      const resetVideoUrl = config?.meetingLink || config?.dailyRoomUrl || "";
      setLocationType(resetVideoUrl ? "custom_link" : "phone");
      setLocationValue(resetVideoUrl);
      setPhoneInfo("");
      setValidationErrors({});
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function selectContact(contact: { name: string; email: string }, idx: number) {
    setAttendees((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], name: contact.name, email: contact.email };
      return next;
    });
    setShowContacts(false);
    setContactSearch("");
    setValidationErrors((prev) => { const n = { ...prev }; delete n.attendees; return n; });
  }

  function addAttendee() {
    setAttendees((prev) => [...prev, { name: "", email: "", phone: "" }]);
  }

  function removeAttendee(idx: number) {
    setAttendees((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateAttendee(idx: number, field: "name" | "email" | "phone", value: string) {
    setAttendees((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
    if (field === "email" && value) {
      setValidationErrors((prev) => { const n = { ...prev }; delete n.attendees; return n; });
    }
  }

  function getMeetingUrl(): string | null {
    if (locationType === "phone") return phoneInfo.trim() || null;
    if (locationType === "custom_link") return locationValue || null;
    return null;
  }

  function getMeetingType(): string {
    if (locationType === "phone") return "phone";
    return "video";
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};

    if (!date) errors.date = "Date is required";
    if (!time) errors.time = "Time is required";
    if (!subject.trim()) errors.subject = "Subject is required";

    const validAttendees = attendees.filter((a) => a.name.trim() || a.email.trim());
    if (validAttendees.length === 0) errors.attendees = "At least one attendee is required";

    if (locationType === "custom_link" && !locationValue.trim()) errors.location = "Meeting link is required";

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    setValidationErrors({});
    const primaryName = validAttendees[0]?.name || null;
    const allEmails = validAttendees.map((a) => a.email).filter(Boolean);
    const allNames = validAttendees.map((a) => a.name).filter(Boolean);

    const details: Record<string, { name?: string; phone?: string }> = {};
    for (const a of validAttendees) {
      if (a.email && (a.name || a.phone)) {
        details[a.email.toLowerCase()] = { name: a.name || undefined, phone: a.phone || undefined };
      }
    }

    createMutation.mutate({
      scheduledAt: new Date(`${date}T${time}:00`).toISOString(),
      bookerTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      duration,
      subject: subject.trim(),
      attendeeName: allNames.length > 1 ? allNames.join(", ") : primaryName,
      attendeeEmails: allEmails,
      attendeeDetails: Object.keys(details).length > 0 ? details : undefined,
      notes: notes || null,
      meetingType: getMeetingType(),
      meetingUrl: getMeetingUrl(),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Appointment</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Date <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => { setDate(e.target.value); setValidationErrors((p) => { const n = { ...p }; delete n.date; return n; }); }}
                data-testid="input-appt-date"
                className={`h-[42px] ${validationErrors.date ? "border-destructive" : ""}`}
              />
              {validationErrors.date && <p className="text-xs text-destructive">{validationErrors.date}</p>}
            </div>
            <div className="space-y-1">
              <Label>Time <span className="text-destructive">*</span></Label>
              <Input
                type="time"
                value={time}
                onChange={(e) => { setTime(e.target.value); setValidationErrors((p) => { const n = { ...p }; delete n.time; return n; }); }}
                data-testid="input-appt-time"
                className={`h-[42px] ${validationErrors.time ? "border-destructive" : ""}`}
              />
              {validationErrors.time && <p className="text-xs text-destructive">{validationErrors.time}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Duration</Label>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                <SelectTrigger data-testid="select-appt-duration"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[15, 30, 45, 60].map((d) => (
                    <SelectItem key={d} value={String(d)}>{d} min</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Subject <span className="text-destructive">*</span></Label>
              <Input
                value={subject}
                onChange={(e) => { setSubject(e.target.value); setValidationErrors((p) => { const n = { ...p }; delete n.subject; return n; }); }}
                placeholder="Meeting subject"
                data-testid="input-appt-subject"
                className={validationErrors.subject ? "border-destructive" : ""}
              />
              {validationErrors.subject && <p className="text-xs text-destructive">{validationErrors.subject}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Location <span className="text-destructive">*</span></Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={locationType === "custom_link" ? "default" : "outline"}
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => { setLocationType("custom_link"); setLocationValue(config?.meetingLink || config?.dailyRoomUrl || ""); }}
                data-testid="button-location-video"
              >
                <Video className="w-3.5 h-3.5" /> Video Link
              </Button>
              <Button
                type="button"
                variant={locationType === "phone" ? "default" : "outline"}
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setLocationType("phone")}
                data-testid="button-location-phone"
              >
                <Phone className="w-3.5 h-3.5" /> Phone Call
              </Button>
            </div>
            {locationType === "custom_link" && (
              <div className="space-y-1">
                <Input
                  value={locationValue}
                  onChange={(e) => { setLocationValue(e.target.value); setValidationErrors((p) => { const n = { ...p }; delete n.location; return n; }); }}
                  placeholder="https://zoom.us/j/... or Google Meet link"
                  data-testid="input-appt-location"
                  className={validationErrors.location ? "border-destructive text-sm" : "text-sm"}
                />
                {(() => {
                  const defUrl = config?.meetingLink || config?.dailyRoomUrl;
                  if (!defUrl || locationValue === defUrl) return null;
                  return (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setLocationValue(defUrl)}
                    >
                      Use default: {defUrl.length > 40 ? defUrl.slice(0, 40) + "..." : defUrl}
                    </button>
                  );
                })()}
                {validationErrors.location && <p className="text-xs text-destructive">{validationErrors.location}</p>}
              </div>
            )}
            {locationType === "phone" && (
              <div className="space-y-1">
                <Input
                  value={phoneInfo}
                  onChange={(e) => setPhoneInfo(e.target.value)}
                  placeholder="Phone number or note, e.g. 'I will call you'"
                  data-testid="input-appt-phone"
                  className="text-sm"
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Attendees <span className="text-destructive">*</span></Label>
              <button type="button" onClick={addAttendee} className="text-xs text-primary hover:underline flex items-center gap-1" data-testid="button-add-attendee">
                <Plus className="w-3 h-3" /> Add Another
              </button>
            </div>
            {validationErrors.attendees && <p className="text-xs text-destructive">{validationErrors.attendees}</p>}
            {attendees.map((att, idx) => (
              <div key={idx} className="relative">
                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <Input
                      value={att.name}
                      onChange={(e) => {
                        updateAttendee(idx, "name", e.target.value);
                        setContactSearch(e.target.value);
                        setActiveAttendeeIdx(idx);
                        setShowContacts(e.target.value.length > 0);
                      }}
                      onFocus={() => {
                        setActiveAttendeeIdx(idx);
                        if (att.name.length > 0 || (contacts && contacts.length > 0)) {
                          setContactSearch(att.name);
                          setShowContacts(true);
                        }
                      }}
                      onBlur={() => setTimeout(() => setShowContacts(false), 200)}
                      placeholder="Name"
                      data-testid={`input-attendee-name-${idx}`}
                      className="text-sm"
                    />
                    {showContacts && activeAttendeeIdx === idx && filteredContacts.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border rounded-[var(--radius)] shadow-lg max-h-40 overflow-y-auto">
                        {filteredContacts.slice(0, 8).map((c, ci) => (
                          <button
                            key={ci}
                            type="button"
                            className="w-full text-left px-3 py-2 hover:bg-secondary/50 transition-colors text-sm flex items-center gap-2"
                            onMouseDown={() => selectContact(c, idx)}
                            data-testid={`contact-option-${ci}`}
                          >
                            <User className="w-3 h-3 text-muted-foreground shrink-0" />
                            <span className="font-ui truncate">{c.name}</span>
                            <span className="text-xs text-muted-foreground truncate ml-auto">{c.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Input
                    type="email"
                    value={att.email}
                    onChange={(e) => updateAttendee(idx, "email", e.target.value)}
                    placeholder="email@example.com"
                    data-testid={`input-attendee-email-${idx}`}
                    className="flex-1 text-sm"
                  />
                  {attendees.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeAttendee(idx)} data-testid={`button-remove-attendee-${idx}`}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
                <div className="mt-1">
                  <Input
                    type="tel"
                    value={att.phone}
                    onChange={(e) => updateAttendee(idx, "phone", e.target.value)}
                    placeholder="Mobile (optional)"
                    data-testid={`input-attendee-phone-${idx}`}
                    className="text-sm"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" data-testid="input-appt-notes" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMutation.isPending} data-testid="button-create-appointment">
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SuggestTimeForm({ bookingId, onCancel, onSuccess }: { bookingId: string; onCancel: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [suggestDate, setSuggestDate] = useState("");
  const [suggestTime, setSuggestTime] = useState("10:00");
  const [message, setMessage] = useState("");

  const suggestMutation = useMutation({
    mutationFn: async () => {
      if (!suggestDate || !suggestTime) throw new Error("Please select a date and time");
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/suggest-time`, {
        scheduledAt: new Date(`${suggestDate}T${suggestTime}:00`).toISOString(),
        message: message || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "New time suggested", description: "The parent has been notified.", variant: "success" });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-2 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={suggestDate} onChange={(e) => setSuggestDate(e.target.value)} data-testid="input-suggest-date" className="h-8 text-xs" />
        <Input type="time" value={suggestTime} onChange={(e) => setSuggestTime(e.target.value)} data-testid="input-suggest-time" className="h-8 text-xs" />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="w-full text-xs rounded-[var(--radius)] border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        data-testid="input-suggest-message"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => suggestMutation.mutate()} disabled={suggestMutation.isPending || !suggestDate} data-testid="button-send-suggestion">
          {suggestMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Send
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function PendingBookingCard({ booking, start, onSelect, readOnly }: { booking: any; start: Date; onSelect: (b: any) => void; readOnly?: boolean }) {
  const { toast } = useToast();
  const [showSuggest, setShowSuggest] = useState(false);

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" });
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/decline`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" });
    },
  });

  const acting = confirmMutation.isPending || declineMutation.isPending;

  return (
    <div
      className="bg-[hsl(var(--brand-warning)/0.08)] rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.3)] p-3 space-y-2"
      style={{ borderLeft: "3px solid hsl(var(--brand-warning))" }}
      data-testid={`pending-card-${booking.id}`}
    >
      <button
        onClick={() => onSelect(booking)}
        className="w-full text-left cursor-pointer hover:opacity-80 transition-opacity"
        data-testid={`pending-detail-${booking.id}`}
      >
        <p className="text-sm font-ui truncate">{booking.attendeeName || booking.subject || "Meeting Request"}</p>
        <p className="text-xs text-muted-foreground">
          {format(start, "EEE, MMM d")} · {format(start, "h:mm a")} · {booking.duration}min
        </p>
        {booking.subject && booking.attendeeName && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{booking.subject}</p>
        )}
      </button>
      {readOnly ? (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-ui bg-[hsl(var(--brand-warning)/0.08)] text-[hsl(var(--brand-warning))] border border-[hsl(var(--brand-warning)/0.3)]">
          Awaiting Confirmation
        </span>
      ) : showSuggest ? (
        <SuggestTimeForm bookingId={booking.id} onCancel={() => setShowSuggest(false)} onSuccess={() => setShowSuggest(false)} />
      ) : (
        <div className="flex gap-1.5 flex-nowrap">
          <Button
            size="sm"
            className="h-7 text-xs gap-1 px-2.5"
            onClick={() => confirmMutation.mutate()}
            disabled={acting}
            data-testid={`button-confirm-pending-${booking.id}`}
          >
            {confirmMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 px-2.5 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={() => declineMutation.mutate()}
            disabled={acting}
            data-testid={`button-decline-pending-${booking.id}`}
          >
            {declineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            Decline
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 px-2"
            onClick={() => setShowSuggest(true)}
            disabled={acting}
            data-testid={`button-suggest-time-${booking.id}`}
          >
            <CalendarClock className="w-3 h-3" /> New Time
          </Button>
        </div>
      )}
    </div>
  );
}

function useRightTimeGutter(view: string) {
  const calendarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = calendarRef.current;
    if (!wrapper) return;

    const existing = wrapper.querySelector(".right-gutter-col") as HTMLElement;
    if (existing) existing.remove();

    if (view !== Views.WEEK && view !== Views.DAY && view !== MULTI_DAY_KEY) return;

    const timeContent = wrapper.querySelector(".rbc-time-content") as HTMLElement;
    if (!timeContent) return;

    const col = document.createElement("div");
    col.className = "right-gutter-col";

    for (let h = 0; h < 24; h++) {
      const label = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
      const slot = document.createElement("div");
      slot.className = "right-gutter-slot";
      const span = document.createElement("span");
      span.className = "right-gutter-label";
      span.textContent = label;
      slot.appendChild(span);
      col.appendChild(slot);
    }

    timeContent.appendChild(col);

    return () => {
      col.remove();
    };
  }, [view]);

  return calendarRef;
}

function BlockEditForm({
  block,
  onUpdate,
  onDelete,
  onClose,
  isUpdating,
  isDeleting,
}: {
  block: any;
  onUpdate: (data: any) => void;
  onDelete: () => void;
  onClose: () => void;
  isUpdating: boolean;
  isDeleting: boolean;
}) {
  const [title, setTitle] = useState(block.title || "Busy");
  const [blockType, setBlockType] = useState<"busy" | "available">(block.blockType || "busy");
  const blockStart = new Date(block.startTime);
  const blockEnd = new Date(block.endTime);
  const [date, setDate] = useState(format(blockStart, "yyyy-MM-dd"));
  const [startTime, setStartTime] = useState(format(blockStart, "HH:mm"));
  const [endTime, setEndTime] = useState(format(blockEnd, "HH:mm"));
  const [recurrence, setRecurrence] = useState<string>(block.recurrence || "none");
  const [recurrenceEnd, setRecurrenceEnd] = useState<string>(block.recurrenceEnd ? format(new Date(block.recurrenceEnd), "yyyy-MM-dd") : "");

  const handleBlockTypeChange = (newType: "busy" | "available") => {
    setBlockType(newType);
    if (title === "Busy" && newType === "available") setTitle("Available");
    else if (title === "Available" && newType === "busy") setTitle("Busy");
  };

  const handleSave = () => {
    const newStart = new Date(`${date}T${startTime}:00`);
    const newEnd = new Date(`${date}T${endTime}:00`);
    if (newEnd <= newStart) return;
    onUpdate({
      title,
      blockType,
      startTime: newStart.toISOString(),
      endTime: newEnd.toISOString(),
      recurrence: recurrence === "none" ? null : recurrence,
      recurrenceEnd: recurrenceEnd ? new Date(`${recurrenceEnd}T23:59:59`).toISOString() : null,
    });
  };

  const isRecurringOccurrence = !!block._parentId;

  return (
    <div className="space-y-4" data-testid="block-edit-form">
      {isRecurringOccurrence && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded-[var(--radius)]">
          <Repeat className="w-3 h-3" />
          This is part of a recurring series. Changes apply to the entire series.
        </div>
      )}
      <div className="space-y-2">
        <Label>Type</Label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleBlockTypeChange("available")}
            className={`flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-sm font-ui transition-colors ${
              blockType === "available"
                ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] border border-[hsl(var(--brand-success)/0.3)]"
                : "text-muted-foreground hover:bg-secondary/30"
            }`}
            data-testid="button-block-available"
          >
            <CalendarCheck className="w-4 h-4" /> Available
          </button>
          <button
            type="button"
            onClick={() => handleBlockTypeChange("busy")}
            className={`flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-sm font-ui transition-colors ${
              blockType === "busy"
                ? "bg-destructive/15 text-destructive border border-destructive/30"
                : "text-muted-foreground hover:bg-secondary/30"
            }`}
            data-testid="button-block-unavailable"
          >
            <Ban className="w-4 h-4" /> Unavailable
          </button>
        </div>
      </div>
      <div className="space-y-2">
        <Label>Title</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={blockType === "available" ? "Available" : "Busy"}
          data-testid="input-block-title"
        />
      </div>
      <div className="space-y-2">
        <Label>Date</Label>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          data-testid="input-block-date"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Start</Label>
          <Input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            data-testid="input-block-start"
          />
        </div>
        <div className="space-y-2">
          <Label>End</Label>
          <Input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            data-testid="input-block-end"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Repeat</Label>
        <Select value={recurrence} onValueChange={setRecurrence} data-testid="select-recurrence">
          <SelectTrigger data-testid="select-recurrence-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Does not repeat</SelectItem>
            <SelectItem value="daily">Every day</SelectItem>
            <SelectItem value="weekly">Every week</SelectItem>
            <SelectItem value="monthly">Every month</SelectItem>
            <SelectItem value="yearly">Every year</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {recurrence !== "none" && (
        <div className="space-y-2">
          <Label>End date <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input
            type="date"
            value={recurrenceEnd}
            onChange={(e) => setRecurrenceEnd(e.target.value)}
            min={date}
            data-testid="input-recurrence-end"
          />
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        {format(blockStart, "EEE, MMM d · h:mm a")} – {format(blockEnd, "h:mm a")}
      </div>
      <DialogFooter className="flex justify-between sm:justify-between">
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          disabled={isUpdating || isDeleting}
          data-testid="button-delete-block"
        >
          {isDeleting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
          {isRecurringOccurrence ? "Delete Series" : "Delete"}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isUpdating || isDeleting} data-testid="button-cancel-block">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isUpdating || isDeleting} data-testid="button-save-block">
            {isUpdating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Check className="w-3 h-3 mr-1" />}
            Save
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}

function RescheduleForm({ bookingId, onCancel, onSuccess }: { bookingId: string; onCancel: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("10:00");
  const [message, setMessage] = useState("");

  const rescheduleMutation = useMutation({
    mutationFn: async () => {
      if (!rescheduleDate || !rescheduleTime) throw new Error("Please select a date and time");
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/reschedule`, {
        scheduledAt: new Date(`${rescheduleDate}T${rescheduleTime}:00`).toISOString(),
        message: message || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting rescheduled", variant: "success" });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-2 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} data-testid="input-reschedule-date" className="h-8 text-xs" />
        <Input type="time" value={rescheduleTime} onChange={(e) => setRescheduleTime(e.target.value)} data-testid="input-reschedule-time" className="h-8 text-xs" />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="w-full text-xs rounded-[var(--radius)] border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        data-testid="input-reschedule-message"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => rescheduleMutation.mutate()} disabled={rescheduleMutation.isPending || !rescheduleDate} data-testid="button-confirm-reschedule">
          {rescheduleMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Reschedule
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function BookingDetailDialog({ booking, open, onClose }: { booking: any; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [showSuggestForm, setShowSuggestForm] = useState(false);
  const [showRescheduleForm, setShowRescheduleForm] = useState(false);
  const isProvider = booking?.providerUserId === user?.id;
  const isPending = booking?.status === "PENDING";
  const isConfirmed = booking?.status === "CONFIRMED";

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/calendar/bookings/${booking.id}`, { status: "CANCELLED" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Booking cancelled", variant: "success" });
      onClose();
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" });
      onClose();
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/decline`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" });
      onClose();
    },
  });

  if (!booking) return null;
  const start = new Date(booking.scheduledAt);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg" style={{ backgroundColor: booking.status === "PENDING" ? "hsl(var(--brand-warning))" : "hsl(var(--primary))" }} />
        <DialogHeader>
          <DialogTitle>{booking.subject || "Appointment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span>{format(start, "EEEE, MMMM d, yyyy")} at {format(start, "h:mm a")}</span>
            <span className="text-muted-foreground">({booking.duration} min)</span>
          </div>
          {booking.providerUser && (
            <div className="flex items-center gap-2 text-sm">
              <Crown className="w-4 h-4 text-primary" />
              <span>{booking.providerUser.name || booking.providerUser.email}</span>
              <span className="text-xs text-muted-foreground">(Host)</span>
            </div>
          )}
          {(() => {
            const members = booking.parentAccountMembers || [];
            if (members.length > 0) {
              return members.map((m: any) => (
                <div key={m.id} className="flex items-center gap-2 text-sm">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span>{m.name || m.email}</span>
                </div>
              ));
            }
            if (booking.parentUser) {
              return (
                <div className="flex items-center gap-2 text-sm">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span>{booking.parentUser.name || booking.parentUser.email}</span>
                </div>
              );
            }
            return null;
          })()}
          {booking.meetingUrl && (
            <div className="flex items-center gap-2 text-sm">
              <Video className="w-4 h-4 text-muted-foreground" />
              <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">{booking.meetingUrl}</a>
            </div>
          )}
          {booking.notes && (
            <p className="text-sm text-muted-foreground bg-secondary/30 rounded-[var(--radius)] p-2">{booking.notes}</p>
          )}
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui ${
              booking.status === "CONFIRMED" ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]" :
              booking.status === "CANCELLED" ? "bg-destructive/15 text-destructive" :
              booking.status === "PENDING" ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]" :
              "bg-muted text-foreground"
            }`}>
              {booking.status === "PENDING" ? "Awaiting Confirmation" : booking.status}
            </span>
          </div>
          {isConfirmed && booking.providerUser?.dailyRoomUrl && booking.meetingType !== "phone" && (
            <a
              href={`/room/${booking.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 w-full justify-center rounded-[var(--radius)] px-4 py-2.5 text-sm font-ui bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
              data-testid={isProvider ? "button-start-meeting" : "button-join-meeting"}
            >
              <Video className="w-4 h-4" />
              {isProvider ? "Start Meeting" : "Join Meeting"}
            </a>
          )}

          {isPending && isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-sm text-[hsl(var(--brand-warning))] font-ui">This meeting request needs your confirmation</p>
              <p className="text-xs text-[hsl(var(--brand-warning))] mt-1">Requested by {booking.attendeeName || booking.parentUser?.name || "a parent"}.</p>
            </div>
          )}

          {isPending && !isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-sm text-[hsl(var(--brand-warning))] font-ui">Awaiting provider confirmation</p>
            </div>
          )}

          {booking.actualEndedAt && booking.consentGiven && (
            <Link
              to={`/recordings/${booking.id}`}
              className="inline-flex items-center gap-2 w-full justify-center rounded-[var(--radius)] px-4 py-2.5 text-sm font-ui border border-border hover:bg-secondary/50 transition-colors"
              data-testid="link-view-recording"
            >
              <FileText className="w-4 h-4" />
              View Recording & Transcript
            </Link>
          )}
        </div>
        {showSuggestForm && isPending && isProvider && (
          <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
            <p className="text-sm font-ui">Suggest a new time</p>
            <SuggestTimeForm
              bookingId={booking.id}
              onCancel={() => setShowSuggestForm(false)}
              onSuccess={() => { setShowSuggestForm(false); onClose(); }}
            />
          </div>
        )}
        {showRescheduleForm && (isConfirmed || (isPending && !isProvider)) && (
          <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
            <p className="text-sm font-ui">Reschedule to a new time</p>
            <RescheduleForm
              bookingId={booking.id}
              onCancel={() => setShowRescheduleForm(false)}
              onSuccess={() => { setShowRescheduleForm(false); onClose(); }}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-4 border-t">
          {isPending && isProvider && !showSuggestForm && (
            <>
              <Button size="sm" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} className="gap-1" data-testid="button-confirm-booking">
                {confirmMutation.isPending ? "Confirming..." : <><Check className="w-4 h-4" /> Confirm</>}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive gap-1" onClick={() => declineMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} data-testid="button-decline-booking">
                {declineMutation.isPending ? "Declining..." : <><X className="w-4 h-4" /> Decline</>}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowSuggestForm(true)} data-testid="button-suggest-new-time">
                <CalendarClock className="w-4 h-4" /> New Time
              </Button>
            </>
          )}
          {(isConfirmed || (isPending && !isProvider)) && !showRescheduleForm && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowRescheduleForm(true)} data-testid="button-reschedule-booking">
              <CalendarClock className="w-4 h-4" /> Reschedule
            </Button>
          )}
          {booking.status !== "CANCELLED" && booking.status !== "RESCHEDULED" && (!isPending || !isProvider) && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} data-testid="button-cancel-booking">
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Booking"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onClose} className="ml-auto">Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ParentBookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const { data: providers } = useQuery<any[]>({
    queryKey: ["/api/calendar/bookable-providers"],
    enabled: open,
  });

  const filtered = useMemo(() => {
    if (!providers) return [];
    if (!search.trim()) return providers;
    const q = search.toLowerCase();
    return providers.filter((p: any) =>
      p.name?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q) || p.providerName?.toLowerCase().includes(q)
    );
  }, [providers, search]);

  function selectProvider(p: any) {
    setShowDropdown(false);
    setSearch("");
    onClose();
    navigate(`/book/${p.slug}`);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setSearch(""); setShowDropdown(false); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Appointment</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Provider <span className="text-destructive">*</span></Label>
          <div className="relative">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              placeholder="Name"
              data-testid="input-search-providers"
              className="text-sm"
            />
            {showDropdown && filtered.length > 0 && (
              <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border rounded-[var(--radius)] shadow-lg max-h-40 overflow-y-auto">
                {filtered.slice(0, 8).map((p: any) => (
                  <button
                    key={p.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-secondary/50 transition-colors text-sm flex items-center gap-2"
                    onMouseDown={() => selectProvider(p)}
                    data-testid={`button-select-provider-${p.id}`}
                  >
                    <User className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="font-ui truncate">{p.name}</span>
                    <span className="text-xs text-muted-foreground truncate ml-auto">{p.providerName || p.email}</span>
                  </button>
                ))}
              </div>
            )}
            {showDropdown && search.trim() && filtered.length === 0 && (
              <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border rounded-[var(--radius)] shadow-lg px-3 py-3">
                <p className="text-sm text-muted-foreground" data-testid="text-no-providers">No providers found.</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MiniCalendar({
  currentDate,
  onDateSelect,
  events,
}: {
  currentDate: Date;
  onDateSelect: (d: Date) => void;
  events: CalendarEvent[];
}) {
  const [displayMonth, setDisplayMonth] = useState(new Date(currentDate));

  useEffect(() => {
    if (!isSameMonth(displayMonth, currentDate)) {
      setDisplayMonth(new Date(currentDate));
    }
  }, [currentDate]);

  const monthStart = startOfMonth(displayMonth);
  const monthEnd = endOfMonth(displayMonth);
  const calStart = startOfWeek(monthStart);
  const calEnd = addDays(startOfWeek(addDays(monthEnd, 7)), -1);
  const days = eachDayOfInterval({ start: calStart, end: calEnd });
  const today = new Date();

  const eventDates = useMemo(() => {
    const map = new Map<string, Set<string>>();
    events.forEach((e) => {
      const key = format(e.start, "yyyy-MM-dd");
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(e.type);
    });
    return map;
  }, [events]);

  return (
    <div className="p-4" data-testid="mini-calendar">
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-border/20">
        <h3 className="text-sm font-heading text-foreground">
          {format(displayMonth, "MMMM yyyy")}
        </h3>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setDisplayMonth((d) => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
            className="p-1 rounded-[var(--radius)] hover:bg-secondary/60 text-muted-foreground transition-colors"
            data-testid="mini-cal-prev"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setDisplayMonth((d) => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
            className="p-1 rounded-[var(--radius)] hover:bg-secondary/60 text-muted-foreground transition-colors"
            data-testid="mini-cal-next"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="text-center text-[10px] font-ui text-muted-foreground/70 py-1">{d}</div>
        ))}
        {days.map((day) => {
          const isToday = isSameDay(day, today);
          const isSelected = isSameDay(day, currentDate);
          const isCurrentMonth = isSameMonth(day, displayMonth);
          const dateKey = format(day, "yyyy-MM-dd");
          const dayEvents = eventDates.get(dateKey);

          return (
            <button
              key={day.toISOString()}
              onClick={() => onDateSelect(day)}
              className={`
                relative flex flex-col items-center py-1 text-[11px] rounded-[var(--radius)] transition-colors
                ${isCurrentMonth ? "text-foreground" : "text-muted-foreground/40"}
                ${isSelected && !isToday ? "bg-primary/10 text-primary font-heading" : ""}
                ${isToday ? "bg-primary text-primary-foreground font-heading" : ""}
                ${!isToday && !isSelected ? "hover:bg-secondary/60" : ""}
              `}
              data-testid={`mini-cal-day-${dateKey}`}
            >
              <span>{format(day, "d")}</span>
              {dayEvents && dayEvents.size > 0 && (
                <div className="flex gap-[2px] mt-[2px]">
                  {dayEvents.has("booking") && <span className="w-[5px] h-[5px] rounded-full bg-primary" />}
                  {dayEvents.has("block") && <span className="w-[5px] h-[5px] rounded-full bg-[hsl(var(--brand-warning))]" />}
                  {dayEvents.has("external") && <span className="w-[5px] h-[5px] rounded-full bg-accent/60" />}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CalendarPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const companyName = useCompanyName();
  const isMobile = useIsMobile();
  const roles = (user as any)?.roles || [];
  const isParentUser = roles.includes("PARENT") && roles.length === 1;
  const isAdminUser = roles.includes("GOSTORK_ADMIN");
  const canParentBook = isParentUser && (user as any)?.parentAccountRole !== "VIEWER";
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<string>(isMobile ? MULTI_DAY_KEY : Views.WEEK);
  const calendarWrapperRef = useRightTimeGutter(view);

  useEffect(() => {
    setView((prev) => {
      if (isMobile && prev === Views.WEEK) return MULTI_DAY_KEY;
      if (!isMobile && prev === MULTI_DAY_KEY) return Views.WEEK;
      return prev;
    });
  }, [isMobile]);
  const [showList, setShowList] = useState(false);
  const [pastMeetingsTab, setPastMeetingsTab] = useState<"meetings" | "recordings" | "transcripts">("meetings");
  const [sidebarTab, setSidebarTab] = useState<"upcoming" | "past" | "recordings" | "transcripts">("upcoming");
  const [createOpen, setCreateOpen] = useState(false);
  const [parentBookOpen, setParentBookOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [selectedBlock, setSelectedBlock] = useState<any>(null);
  const [selectedExternalEvent, setSelectedExternalEvent] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchFrom, setSearchFrom] = useState("");
  const [searchTo, setSearchTo] = useState("");
  const [searchHostId, setSearchHostId] = useState("");
  const [searchParentId, setSearchParentId] = useState("");
  const [mobileDateOpen, setMobileDateOpen] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [adminProviderScope, setAdminProviderScope] = useState<string>("");

  const { data: allProviders } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isAdminUser,
    staleTime: 60000,
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const hasActiveSearch = !!(debouncedQuery || searchFrom || searchTo || searchHostId || searchParentId);

  const searchParams = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQuery) p.set("q", debouncedQuery);
    if (searchFrom) {
      const [y, m, d] = searchFrom.split("-").map(Number);
      p.set("from", new Date(y, m - 1, d, 0, 0, 0, 0).toISOString());
    }
    if (searchTo) {
      const [y, m, d] = searchTo.split("-").map(Number);
      p.set("to", new Date(y, m - 1, d, 23, 59, 59, 999).toISOString());
    }
    if (searchHostId) p.set("hostId", searchHostId);
    if (searchParentId) p.set("parentId", searchParentId);
    if (isAdminUser && adminProviderScope) p.set("providerId", adminProviderScope);
    return p.toString();
  }, [debouncedQuery, searchFrom, searchTo, searchHostId, searchParentId, isAdminUser, adminProviderScope]);

  const { data: searchResults, isLoading: searchLoading } = useQuery<any[]>({
    queryKey: ["/api/calendar/bookings/search", searchParams],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/bookings/search?${searchParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: hasActiveSearch,
    staleTime: 10000,
  });

  const clearSearch = () => {
    setSearchQuery("");
    setSearchFrom("");
    setSearchTo("");
    setSearchHostId("");
    setSearchParentId("");
  };

  const rangeStart = subDays(startOfMonth(currentDate), 7);
  const rangeEnd = addDays(endOfMonth(currentDate), 7);

  const { data: config } = useQuery({
    queryKey: ["/api/calendar/config"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/config", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: bookings, isLoading: bookingsLoading } = useQuery({
    queryKey: ["/api/calendar/bookings", rangeStart.toISOString(), rangeEnd.toISOString(), isAdminUser ? adminProviderScope : ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("from", rangeStart.toISOString());
      params.set("to", rangeEnd.toISOString());
      if (isAdminUser && adminProviderScope) params.set("providerId", adminProviderScope);
      const res = await fetch(
        `/api/calendar/bookings?${params.toString()}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  useEffect(() => {
    const bookingIdParam = urlParams.get("bookingId");
    if (!bookingIdParam || !bookings) return;
    const found = bookings.find((b: any) => b.id === bookingIdParam);
    if (found) {
      setSelectedBooking(found);
      setUrlParams((prev) => { const next = new URLSearchParams(prev); next.delete("bookingId"); return next; }, { replace: true });
    } else {
      fetch(`/api/calendar/bookings/${bookingIdParam}`, { credentials: "include" })
        .then((res) => res.ok ? res.json() : null)
        .then((b) => {
          if (b) {
            setSelectedBooking(b);
            setCurrentDate(new Date(b.scheduledAt));
          }
          setUrlParams((prev) => { const next = new URLSearchParams(prev); next.delete("bookingId"); return next; }, { replace: true });
        })
        .catch(() => {
          setUrlParams((prev) => { const next = new URLSearchParams(prev); next.delete("bookingId"); return next; }, { replace: true });
        });
    }
  }, [bookings, urlParams, setUrlParams]);

  const uniqueHosts = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    (bookings || []).forEach((b: any) => {
      if (b.providerUser?.id && b.providerUser?.name) {
        map.set(b.providerUser.id, { id: b.providerUser.id, name: b.providerUser.name });
      }
    });
    return Array.from(map.values());
  }, [bookings]);

  const uniqueParents = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    (bookings || []).forEach((b: any) => {
      if (b.parentUser?.id && b.parentUser?.name) {
        map.set(b.parentUser.id, { id: b.parentUser.id, name: b.parentUser.name });
      }
      (b.parentAccountMembers || []).forEach((m: any) => {
        if (m.id && m.name) map.set(m.id, { id: m.id, name: m.name });
      });
    });
    return Array.from(map.values());
  }, [bookings]);

  const { data: allRecordings } = useQuery<any[]>({
    queryKey: ["/api/video/all-recordings"],
    queryFn: async () => {
      const res = await fetch("/api/video/all-recordings", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30000,
  });

  const recordingsByBookingId = useMemo(() => {
    const map: Record<string, { recording: any; consentGiven: boolean }> = {};
    (allRecordings || []).forEach((r: any) => {
      map[r.id] = { recording: r.recording, consentGiven: r.consentGiven };
    });
    return map;
  }, [allRecordings]);


  const { data: blocks } = useQuery({
    queryKey: ["/api/calendar/blocks", rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: async () => {
      const res = await fetch(
        `/api/calendar/blocks?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: connections } = useQuery<any[]>({
    queryKey: ["/api/calendar/connections"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/connections", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const hasGoogleConnection = connections?.some((c: any) => c.provider === "google" && c.connected);
  const hasMicrosoftConnection = connections?.some((c: any) => c.provider === "microsoft" && c.connected);

  const { data: googleEvents } = useQuery<any[]>({
    queryKey: ["/api/calendar/google/events", rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: async () => {
      const res = await fetch(
        `/api/calendar/google/events?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
        { credentials: "include" }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!hasGoogleConnection,
  });

  const { data: microsoftEvents } = useQuery<any[]>({
    queryKey: ["/api/calendar/microsoft/events", rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: async () => {
      const res = await fetch(
        `/api/calendar/microsoft/events?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
        { credentials: "include" }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!hasMicrosoftConnection,
  });

  const hasCaldavConnection = connections?.some((c: any) => c.provider === "apple" && c.connected);

  const { data: caldavEvents } = useQuery<any[]>({
    queryKey: ["/api/calendar/caldav/events", rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: async () => {
      const res = await fetch(
        `/api/calendar/caldav/events?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
        { credentials: "include" }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!hasCaldavConnection,
  });

  const { data: eventFreeOverrides } = useQuery<any[]>({
    queryKey: ["/api/calendar/event-overrides"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/event-overrides", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const getRecurringBaseId = (eventId: string): string | null => {
    const match = eventId.match(/^(.+?)_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|20\d{6}T\d{6}Z)/);
    return match ? match[1] : null;
  };

  const freeOverrideSet = useMemo(() => {
    const set = new Set<string>();
    (eventFreeOverrides || []).forEach((o: any) => {
      set.add(`${o.provider}::${o.externalEventId}`);
    });
    return set;
  }, [eventFreeOverrides]);

  const isEventFree = (provider: string, eventId: string): boolean => {
    if (freeOverrideSet.has(`${provider}::${eventId}`)) return true;
    const baseId = getRecurringBaseId(eventId);
    if (baseId && freeOverrideSet.has(`${provider}::${baseId}`)) return true;
    return false;
  };

  const getEventOverride = (provider: string, eventId: string): any | null => {
    const directKey = `${provider}::${eventId}`;
    const direct = (eventFreeOverrides || []).find((o: any) => `${o.provider}::${o.externalEventId}` === directKey);
    if (direct) return direct;
    const baseId = getRecurringBaseId(eventId);
    if (baseId) {
      const seriesKey = `${provider}::${baseId}`;
      const series = (eventFreeOverrides || []).find((o: any) => `${o.provider}::${o.externalEventId}` === seriesKey);
      if (series) return { ...series, isSeriesOverride: true };
    }
    return null;
  };

  const freeOverrideMap = useMemo(() => {
    const map = new Map<string, any>();
    (eventFreeOverrides || []).forEach((o: any) => {
      map.set(`${o.provider}::${o.externalEventId}`, o);
    });
    return map;
  }, [eventFreeOverrides]);

  const markEventFreeMutation = useMutation({
    mutationFn: async (data: { externalEventId: string; provider: string; calendarId: string; title?: string }) => {
      await apiRequest("POST", "/api/calendar/event-overrides", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/event-overrides"] });
      toast({ title: "Event marked as available", variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to update event availability", variant: "destructive" });
    },
  });

  const unmarkEventFreeMutation = useMutation({
    mutationFn: async (overrideId: string) => {
      await apiRequest("DELETE", `/api/calendar/event-overrides/${overrideId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/event-overrides"] });
      toast({ title: "Event restored to busy", variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to update event availability", variant: "destructive" });
    },
  });

  const colorDebounceRef = { current: null as any };
  function updateCalendarColor(field: string, value: string) {
    clearTimeout(colorDebounceRef.current);
    queryClient.setQueryData(["/api/calendar/config"], (old: any) =>
      old ? { ...old, [field]: value } : old
    );
    colorDebounceRef.current = setTimeout(async () => {
      try {
        await apiRequest("PUT", "/api/calendar/config", { [field]: value });
        queryClient.invalidateQueries({ queryKey: ["/api/calendar/config"] });
      } catch {}
    }, 500);
  }

  const connColorTimers = {} as Record<string, any>;
  function updateConnectionColor(connId: string, color: string) {
    clearTimeout(connColorTimers[connId]);
    queryClient.setQueryData(["/api/calendar/connections"], (old: any) =>
      old ? old.map((c: any) => c.id === connId ? { ...c, color } : c) : old
    );
    connColorTimers[connId] = setTimeout(async () => {
      try {
        await apiRequest("PATCH", `/api/calendar/connections/${connId}`, { color });
        queryClient.invalidateQueries({ queryKey: ["/api/calendar/connections"] });
      } catch {}
    }, 400);
  }

  const createBlockMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/calendar/blocks", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/blocks"] });
      toast({ title: "Time blocked", variant: "success" });
    },
  });

  const updateBlockMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest("PATCH", `/api/calendar/blocks/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/blocks"] });
      toast({ title: "Block updated", variant: "success" });
      setSelectedBlock(null);
    },
  });

  const deleteBlockMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/calendar/blocks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/blocks"] });
      toast({ title: "Block removed", variant: "success" });
      setSelectedBlock(null);
    },
  });

  const events: CalendarEvent[] = useMemo(() => {
    const result: CalendarEvent[] = [];

    (bookings || []).forEach((b: any) => {
      if (b.status === "CANCELLED" || b.status === "RESCHEDULED") return;
      const start = new Date(b.scheduledAt);
      const end = new Date(start.getTime() + b.duration * 60 * 1000);
      result.push({
        id: b.id,
        title: b.subject || b.attendeeName || "Appointment",
        start,
        end,
        type: "booking",
        resource: b,
      });
    });

    (blocks || []).forEach((block: any) => {
      const isRecurring = !!(block.recurrence || block._parentId);
      result.push({
        id: block.id,
        title: isRecurring ? `↻ ${block.title || "Busy"}` : (block.title || "Busy"),
        start: new Date(block.startTime),
        end: new Date(block.endTime),
        type: "block",
        resource: block,
      });
    });

    if (googleEvents && googleEvents.length > 0) {
      googleEvents.forEach((event: any) => {
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
        const isFree = isEventFree("google", event.id);
        result.push({
          id: `goog-${event.id}`,
          title: event.summary || "Busy",
          start,
          end,
          type: "external",
          resource: { connectionId: event.connectionId, color: event.color, provider: "google", rawEventId: event.id, calendarId: event.calendarId, calendarLabel: event.calendarLabel, isFree },
        });
      });
    }

    if (microsoftEvents && microsoftEvents.length > 0) {
      microsoftEvents.forEach((event: any) => {
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
        const isFree = isEventFree("microsoft", event.id);
        result.push({
          id: `msft-${event.id}`,
          title: event.summary || "Busy",
          start,
          end,
          type: "external",
          resource: { connectionId: event.connectionId, color: event.color, provider: "microsoft", rawEventId: event.id, calendarId: event.calendarId, calendarLabel: event.calendarLabel, isFree },
        });
      });
    }

    if (caldavEvents && caldavEvents.length > 0) {
      caldavEvents.forEach((event: any) => {
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
        const isFree = isEventFree(event.provider, event.id);
        result.push({
          id: `caldav-${event.id}`,
          title: event.title || "Busy",
          start,
          end,
          type: "external",
          resource: { connectionId: event.connectionId, color: event.color, provider: event.provider, rawEventId: event.id, calendarId: event.calendarId, calendarLabel: event.calendarLabel, isFree },
        });
      });
    }

    return result;
  }, [bookings, blocks, connections, googleEvents, microsoftEvents, caldavEvents, freeOverrideSet]);

  const handleSelectSlot = useCallback(
    ({ start, end }: { start: Date; end: Date }) => {
      if (isParentUser) return;
      const duration = end.getTime() - start.getTime();
      const oneHour = 60 * 60 * 1000;
      const adjustedEnd = duration < oneHour ? new Date(start.getTime() + oneHour) : end;
      createBlockMutation.mutate({
        startTime: start.toISOString(),
        endTime: adjustedEnd.toISOString(),
        title: "Busy",
      });
    },
    [createBlockMutation, isParentUser]
  );

  const handleSelectEvent = useCallback((event: CalendarEvent) => {
    if (event.type === "booking") {
      setSelectedBooking(event.resource);
    } else if (event.type === "block") {
      setSelectedBlock(event.resource);
    } else if (event.type === "external") {
      setSelectedExternalEvent({
        ...event.resource,
        title: event.title,
        start: event.start,
        end: event.end,
      });
    }
  }, []);

  const colorExternal = config?.colorExternal || "#8b5cf6";
  const colorBlocks = config?.colorBlocks || "#f59e0b";

  const hexToRgba = useCallback((hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }, []);

  const darkenHex = useCallback((hex: string) => {
    const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - 60);
    const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - 60);
    const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - 60);
    return `rgb(${r},${g},${b})`;
  }, []);

  const eventStyleGetter = useCallback((event: CalendarEvent) => {
    const base: any = {
      borderRadius: "6px",
      border: "none",
      fontSize: "12px",
      boxShadow: "none",
      outline: "none",
      fontWeight: "600",
      cursor: "pointer",
    };
    if (event.type === "booking") {
      const isPending = event.resource?.status === "PENDING";
      if (isPending) {
        return { style: { ...base, backgroundColor: "hsl(var(--brand-warning) / 0.10)", borderLeft: "3px solid hsl(var(--brand-warning))", color: "hsl(var(--brand-warning))" } };
      }
      return { style: { ...base, backgroundColor: "hsl(var(--primary) / 0.08)", borderLeft: "3px solid hsl(var(--primary))", color: "hsl(var(--primary))" } };
    } else if (event.type === "block") {
      if (event.resource?.blockType === "available") {
        return { style: { ...base, backgroundColor: "hsl(var(--brand-success) / 0.10)", borderLeft: "3px solid hsl(var(--brand-success))", color: "hsl(var(--brand-success))" } };
      }
      const c = colorBlocks || "#f59e0b";
      return { style: { ...base, backgroundColor: hexToRgba(c, 0.10), borderLeft: `3px solid ${c}`, color: darkenHex(c) } };
    } else if (event.type === "external") {
      const c = event.resource?.color || colorExternal;
      if (event.resource?.isFree) {
        return { style: { ...base, backgroundColor: hexToRgba(c, 0.04), borderLeft: `3px dashed ${c}`, color: darkenHex(c), opacity: 0.5, textDecoration: "line-through" } };
      }
      return { style: { ...base, backgroundColor: hexToRgba(c, 0.10), borderLeft: `3px solid ${c}`, color: darkenHex(c) } };
    }
    return { style: base };
  }, [colorExternal, colorBlocks, hexToRgba, darkenHex]);

  function copyBookingLink() {
    if (!config?.bookingPageSlug) return;
    navigator.clipboard.writeText(`${window.location.origin}/book/${config.bookingPageSlug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pendingBookings = useMemo(() => {
    const now = new Date();
    return (bookings || [])
      .filter((b: any) => b.status === "PENDING" && new Date(b.scheduledAt) >= now)
      .sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  }, [bookings]);

  const upcomingBookings = useMemo(() => {
    const now = new Date();
    return (bookings || [])
      .filter((b: any) => new Date(b.scheduledAt) >= now && b.status !== "CANCELLED" && b.status !== "RESCHEDULED" && b.status !== "PENDING")
      .sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
      .slice(0, 10);
  }, [bookings]);

  const groupedUpcoming = useMemo(() => {
    const groups: { label: string; date: string; items: any[] }[] = [];
    const today = new Date();
    const tomorrow = addDays(today, 1);
    upcomingBookings.forEach((b: any) => {
      const start = new Date(b.scheduledAt);
      const dateKey = format(start, "yyyy-MM-dd");
      let label: string;
      if (isSameDay(start, today)) {
        label = "TODAY";
      } else if (isSameDay(start, tomorrow)) {
        label = "TOMORROW";
      } else {
        label = format(start, "EEEE").toUpperCase();
      }
      const dateStr = format(start, "M/d/yyyy");
      const existing = groups.find((g) => g.date === dateKey);
      if (existing) {
        existing.items.push(b);
      } else {
        groups.push({ label, date: dateKey, items: [b] });
      }
    });
    return groups;
  }, [upcomingBookings]);

  const sidebarPastBookings = useMemo(() => {
    const now = new Date();
    return (bookings || [])
      .filter((b: any) => new Date(b.scheduledAt) < now && b.status === "CONFIRMED")
      .sort((a: any, b: any) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime())
      .slice(0, 20);
  }, [bookings]);

  const sidebarPastFiltered = useMemo(() => {
    if (sidebarTab === "recordings") {
      return sidebarPastBookings.filter((b: any) => recordingsByBookingId[b.id]?.recording?.status === "ready");
    }
    if (sidebarTab === "transcripts") {
      return sidebarPastBookings.filter((b: any) => recordingsByBookingId[b.id]?.recording?.transcriptStatus === "ready");
    }
    if (sidebarTab === "past") {
      return sidebarPastBookings;
    }
    return [];
  }, [sidebarTab, sidebarPastBookings, recordingsByBookingId]);

  const sidebarRecordingsCount = useMemo(() => sidebarPastBookings.filter((b: any) => recordingsByBookingId[b.id]?.recording?.status === "ready").length, [sidebarPastBookings, recordingsByBookingId]);
  const sidebarTranscriptsCount = useMemo(() => sidebarPastBookings.filter((b: any) => recordingsByBookingId[b.id]?.recording?.transcriptStatus === "ready").length, [sidebarPastBookings, recordingsByBookingId]);

  if (bookingsLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="w-full space-y-3">
      <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">Meetings</h1>
      <div className="space-y-3" data-testid="card-calendar-controls">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg sm:text-2xl md:text-[28px] font-heading text-foreground tracking-heading leading-heading whitespace-nowrap" data-testid="text-calendar-title" style={{ fontFamily: "var(--font-body)" }}>
            {view === Views.DAY ? format(currentDate, "MMMM d, yyyy") : view === MULTI_DAY_KEY ? `${format(currentDate, "MMM d")} – ${format(addDays(currentDate, 1), "MMM d, yyyy")}` : format(currentDate, "MMMM yyyy")}
          </h2>
        </div>
        <div className="flex items-center gap-2 flex-1 justify-end">
          <div className="hidden sm:flex items-center border border-border/40 rounded-[var(--radius)] overflow-hidden">
            <button
              onClick={() => {
                const d = new Date(currentDate);
                if (view === Views.MONTH) d.setMonth(d.getMonth() - 1);
                else if (view === Views.WEEK) d.setDate(d.getDate() - 7);
                else d.setDate(d.getDate() - 1);
                setCurrentDate(d);
              }}
              className="px-2 py-1.5 text-muted-foreground hover:bg-muted/60 transition-colors border-r border-border/40"
              data-testid="button-nav-prev"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              className="px-3 py-1.5 text-xs font-ui text-foreground hover:bg-muted/60 transition-colors border-r border-border/40"
              data-testid="button-today"
            >
              Today
            </button>
            <button
              onClick={() => {
                const d = new Date(currentDate);
                if (view === Views.MONTH) d.setMonth(d.getMonth() + 1);
                else if (view === Views.WEEK) d.setDate(d.getDate() + 7);
                else d.setDate(d.getDate() + 1);
                setCurrentDate(d);
              }}
              className="px-2 py-1.5 text-muted-foreground hover:bg-muted/60 transition-colors"
              data-testid="button-nav-next"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex sm:hidden items-center gap-1">
            <button
              onClick={() => {
                const d = new Date(currentDate);
                if (view === Views.MONTH) d.setMonth(d.getMonth() - 1);
                else if (view === MULTI_DAY_KEY) d.setDate(d.getDate() - 2);
                else if (view === Views.WEEK) d.setDate(d.getDate() - 7);
                else d.setDate(d.getDate() - 1);
                setCurrentDate(d);
              }}
              className="p-1 text-muted-foreground"
              data-testid="button-nav-prev-mobile"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              className="px-2 py-1 text-xs font-ui text-foreground border border-border/40 rounded-[var(--radius)]"
              data-testid="button-today-mobile"
            >
              Today
            </button>
            <button
              onClick={() => {
                const d = new Date(currentDate);
                if (view === Views.MONTH) d.setMonth(d.getMonth() + 1);
                else if (view === MULTI_DAY_KEY) d.setDate(d.getDate() + 2);
                else if (view === Views.WEEK) d.setDate(d.getDate() + 7);
                else d.setDate(d.getDate() + 1);
                setCurrentDate(d);
              }}
              className="p-1 text-muted-foreground"
              data-testid="button-nav-next-mobile"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <div className="hidden sm:flex items-center bg-muted/40 rounded-[var(--radius)] p-0.5">
            {[
              { key: Views.DAY, label: "Day" },
              { key: Views.WEEK, label: "Week" },
              { key: Views.MONTH, label: "Month" },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => { setView(key); setShowList(false); }}
                className={`px-3.5 py-1.5 text-xs font-ui rounded-[var(--radius)] transition-all ${
                  view === key && !showList
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "hover:text-foreground"
                }`}
                style={view === key && !showList ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}
                data-testid={`button-view-${key}`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => setShowList(!showList)}
              className={`px-3 py-1.5 text-xs font-ui rounded-[var(--radius)] transition-all flex items-center gap-1 ${
                showList
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "hover:text-foreground"
              }`}
              style={showList ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}
              data-testid="button-view-list"
            >
              <List className="w-3.5 h-3.5" /> List
            </button>
          </div>
          <div className="hidden lg:block lg:w-[340px] shrink-0">
            <div className="flex items-center gap-2 justify-end">
              {!isParentUser && config?.bookingPageSlug && (
                <Button variant="outline" onClick={copyBookingLink} data-testid="button-copy-booking-link" className="gap-1.5 shadow-none">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  Booking Link
                </Button>
              )}
              {!isParentUser && (
                <Button onClick={() => setCreateOpen(true)} data-testid="button-create-appointment-header" className="gap-1.5">
                  <Plus className="w-4 h-4" /> New Appointment
                </Button>
              )}
              {canParentBook && (
                <Button onClick={() => setParentBookOpen(true)} data-testid="button-parent-new-appointment" className="gap-1.5">
                  <Plus className="w-4 h-4" /> New Appointment
                </Button>
              )}
            </div>
          </div>
          <div className="flex lg:hidden items-center gap-2">
            {!isParentUser && config?.bookingPageSlug && (
              <Button variant="outline" onClick={copyBookingLink} data-testid="button-copy-booking-link-sm" className="hidden sm:inline-flex gap-1.5 shadow-none">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                Booking Link
              </Button>
            )}
            {!isParentUser && config?.bookingPageSlug && (
              <Button variant="outline" size="icon" className="sm:hidden shadow-none" onClick={copyBookingLink} data-testid="button-copy-booking-link-mobile">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </Button>
            )}
            {!isParentUser && (
              <Button onClick={() => setCreateOpen(true)} data-testid="button-create-appointment-sm" className="hidden sm:inline-flex gap-1.5">
                <Plus className="w-4 h-4" /> New Appointment
              </Button>
            )}
            {!isParentUser && (
              <Button size="icon" className="sm:hidden" onClick={() => setCreateOpen(true)} data-testid="button-create-appointment-mobile">
                <Plus className="w-4 h-4" />
              </Button>
            )}
            {canParentBook && (
              <Button onClick={() => setParentBookOpen(true)} data-testid="button-parent-new-appointment-sm" className="hidden sm:inline-flex gap-1.5">
                <Plus className="w-4 h-4" /> New Appointment
              </Button>
            )}
            {canParentBook && (
              <Button size="icon" className="sm:hidden" onClick={() => setParentBookOpen(true)} data-testid="button-parent-new-appointment-mobile">
                <Plus className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex sm:hidden items-center bg-muted/40 rounded-[var(--radius)] p-0.5">
        {[
          { key: Views.DAY, label: "Day" },
          { key: MULTI_DAY_KEY, label: "Multi-Day" },
          { key: Views.MONTH, label: "Month" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => { setView(key); setShowList(false); }}
            className={`flex-1 px-2 py-1.5 text-xs font-ui rounded-[var(--radius)] transition-all text-center ${
              view === key && !showList
                ? "bg-primary text-primary-foreground shadow-sm"
                : "hover:text-foreground"
            }`}
            style={view === key && !showList ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}
            data-testid={`button-view-mobile-${key}`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setShowList(!showList)}
          className={`flex-1 px-2 py-1.5 text-xs font-ui rounded-[var(--radius)] transition-all text-center ${
            showList
              ? "bg-primary text-primary-foreground shadow-sm"
              : "hover:text-foreground"
          }`}
          style={showList ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}
          data-testid="button-view-mobile-list"
        >
          List
        </button>
      </div>

      <div className="flex flex-col gap-2" data-testid="search-panel">
        <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
          {isAdminUser && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant={adminProviderScope ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="select-admin-provider-scope">
                  {adminProviderScope ? (allProviders || []).find((p) => p.id === adminProviderScope)?.name || "All Meetings" : "My Meetings"}
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-2 max-h-60 overflow-y-auto" align="start">
                <div className="space-y-1">
                  <Button variant={!adminProviderScope ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setAdminProviderScope("")}>My Meetings</Button>
                  <Button variant={adminProviderScope === "all" ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setAdminProviderScope("all")}>All Meetings</Button>
                  {(allProviders || []).map((p) => (
                    <Button key={p.id} variant={adminProviderScope === p.id ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs truncate" onClick={() => setAdminProviderScope(p.id)}>{p.name}</Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <div className="relative flex-1 min-w-0 sm:max-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search meetings..."
              className="pl-8 h-8 text-xs focus-visible:ring-0 focus-visible:ring-offset-0"
              data-testid="input-search-query"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant={searchFrom ? "default" : "outline"} size="sm" className="hidden sm:flex shrink-0 h-8 text-xs rounded-full gap-1" data-testid="filter-btn-search-from">
                <Calendar className="w-3 h-3" />
                {searchFrom || "From"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-3" align="start">
              <div className="space-y-2">
                <span className="text-sm font-medium">From Date</span>
                <Input
                  type="date"
                  value={searchFrom}
                  onChange={(e) => setSearchFrom(e.target.value)}
                  className="h-8 text-xs"
                  data-testid="input-search-from"
                />
                {searchFrom && (
                  <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setSearchFrom("")}>Clear</Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant={searchTo ? "default" : "outline"} size="sm" className="hidden sm:flex shrink-0 h-8 text-xs rounded-full gap-1" data-testid="filter-btn-search-to">
                <Calendar className="w-3 h-3" />
                {searchTo || "To"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-3" align="start">
              <div className="space-y-2">
                <span className="text-sm font-medium">To Date</span>
                <Input
                  type="date"
                  value={searchTo}
                  onChange={(e) => setSearchTo(e.target.value)}
                  className="h-8 text-xs"
                  data-testid="input-search-to"
                />
                {searchTo && (
                  <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setSearchTo("")}>Clear</Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
          {uniqueHosts.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant={searchHostId ? "default" : "outline"} size="sm" className="hidden lg:flex shrink-0 h-8 text-xs rounded-full gap-1" data-testid="select-search-host">
                  <User className="w-3 h-3" />
                  {searchHostId ? uniqueHosts.find((h) => h.id === searchHostId)?.name || "Host" : "All hosts"}
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-2 max-h-60 overflow-y-auto" align="start">
                <div className="space-y-1">
                  <Button variant={!searchHostId ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setSearchHostId("")}>All hosts</Button>
                  {uniqueHosts.map((h) => (
                    <Button key={h.id} variant={searchHostId === h.id ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setSearchHostId(h.id)}>{h.name}</Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {uniqueParents.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant={searchParentId ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="select-search-parent">
                  <Users className="w-3 h-3" />
                  {searchParentId ? uniqueParents.find((p) => p.id === searchParentId)?.name || "Parent" : "All parents"}
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-2 max-h-60 overflow-y-auto" align="start">
                <div className="space-y-1">
                  <Button variant={!searchParentId ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setSearchParentId("")}>All parents</Button>
                  {uniqueParents.map((p) => (
                    <Button key={p.id} variant={searchParentId === p.id ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setSearchParentId(p.id)}>{p.name}</Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {hasActiveSearch && (
            <button
              onClick={() => clearSearch()}
              className="text-muted-foreground hover:text-foreground shrink-0"
              data-testid="button-clear-search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setMobileDateOpen(!mobileDateOpen)}
            className={`sm:hidden flex items-center justify-center w-8 h-8 rounded-[var(--radius)] border transition-colors shrink-0 ml-auto ${
              mobileDateOpen || searchFrom || searchTo
                ? "border-primary/30 bg-primary/5 text-primary"
                : "border-border/40 text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-toggle-date-filter"
          >
            <Calendar className="w-4 h-4" />
          </button>
        </div>
        {mobileDateOpen && (
          <div className="flex sm:hidden items-center gap-2">
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <label className="text-xs text-muted-foreground font-ui shrink-0">From</label>
              <Input
                type="date"
                value={searchFrom}
                onChange={(e) => setSearchFrom(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-search-from-mobile"
              />
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <label className="text-xs text-muted-foreground font-ui shrink-0">To</label>
              <Input
                type="date"
                value={searchTo}
                onChange={(e) => setSearchTo(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-search-to-mobile"
              />
            </div>
          </div>
        )}
      </div>
      </div>

      {hasActiveSearch ? (
        <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] overflow-hidden" data-testid="search-results">
          <div className="px-4 py-3 border-b border-border/20 flex items-center justify-between">
            <h3 className="text-sm font-heading text-foreground flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-muted-foreground" />
              Search Results
            </h3>
            <span className="text-xs text-muted-foreground" data-testid="text-search-count">
              {searchLoading ? "Searching..." : `${searchResults?.length || 0} meetings found`}
            </span>
          </div>
          {searchLoading ? (
            <div className="p-12 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !searchResults || searchResults.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm" data-testid="text-no-search-results">
              No meetings found matching your search.
            </div>
          ) : (
            <div>
              {(() => {
                const today = new Date();
                const groups: { key: string; label: string; items: any[] }[] = [];
                searchResults.forEach((b: any) => {
                  const start = new Date(b.scheduledAt);
                  const dayKey = format(start, "yyyy-MM-dd");
                  const label = isSameDay(start, today) ? "Today" : format(start, "EEE, MMM d, yyyy");
                  const existing = groups.find(g => g.key === dayKey);
                  if (existing) existing.items.push(b);
                  else groups.push({ key: dayKey, label, items: [b] });
                });
                return groups.map((group) => (
                  <div key={group.key}>
                    <div className="px-4 py-2 bg-muted/30 border-b border-border/10">
                      <span className="text-[11px] font-heading uppercase tracking-wider text-muted-foreground">{group.label}</span>
                    </div>
                    {group.items.map((b: any) => {
                      const start = new Date(b.scheduledAt);
                      const end = new Date(start.getTime() + (b.duration || 30) * 60 * 1000);
                      const isPast = start < today;
                      const isPending = b.status === "PENDING";
                      const isCancelled = b.status === "CANCELLED" || b.status === "RESCHEDULED";
                      const barColor = isCancelled ? "hsl(var(--muted-foreground))" : isPending ? "hsl(var(--brand-warning))" : isPast ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))";
                      const recInfo = recordingsByBookingId[b.id];
                      const hasRecording = recInfo?.recording?.status === "ready";
                      const hasTranscript = recInfo?.recording?.transcriptStatus === "ready";
                      return (
                        <button
                          key={b.id}
                          onClick={() => setSelectedBooking(b)}
                          className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/40 transition-colors text-left cursor-pointer border-b border-border/10 last:border-b-0"
                          data-testid={`search-result-${b.id}`}
                        >
                          <div className="w-[3px] self-stretch rounded-full shrink-0" style={{ backgroundColor: barColor }} />
                          <div className="flex-1 min-w-0">
                            <p className={`font-heading text-[13px] truncate ${isPast || isCancelled ? "text-muted-foreground" : "text-foreground"}`}>
                              {b.subject || "Meeting"}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {format(start, "h:mm a")} – {format(end, "h:mm a")} · {b.duration || 30}min
                            </p>
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">
                              {b.providerUser?.name && b.parentUser?.name
                                ? `${b.providerUser.name} ↔ ${b.parentUser.name}`
                                : b.attendeeName || b.providerUser?.name || ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {hasRecording && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-ui bg-accent/10 text-accent-foreground border border-accent/30">
                                <Video className="w-3 h-3" /> Recording
                              </span>
                            )}
                            {hasTranscript && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-ui bg-accent/10 text-accent-foreground border border-accent/30">
                                <FileText className="w-3 h-3" /> Transcript
                              </span>
                            )}
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-ui ${
                              isCancelled
                                ? "bg-muted/50 text-muted-foreground border border-border"
                                : isPending
                                  ? "bg-[hsl(var(--brand-warning)/0.08)] text-[hsl(var(--brand-warning))] border border-[hsl(var(--brand-warning)/0.3)]"
                                  : isPast
                                    ? "bg-muted/50 text-muted-foreground border border-border"
                                    : "bg-[hsl(var(--brand-success)/0.08)] text-[hsl(var(--brand-success))] border border-[hsl(var(--brand-success)/0.3)]"
                            }`}>
                              {isCancelled ? (b.status === "RESCHEDULED" ? "Rescheduled" : "Cancelled") : isPending ? "Pending" : isPast ? "Completed" : "Confirmed"}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          )}
        </Card>
      ) : (
      <div className="flex flex-col lg:flex-row gap-4">
        <div className={showList ? "w-full" : "flex-1 min-w-0 overflow-x-auto"}>
          {showList ? (() => {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const tomorrow = addDays(today, 1);
            const listEvents = events.filter(e => e.type === "booking" && e.start >= now).sort((a, b) => a.start.getTime() - b.start.getTime());
            const pastEvents = events.filter(e => e.type === "booking" && e.start < now && e.resource?.status === "CONFIRMED").sort((a, b) => b.start.getTime() - a.start.getTime()).slice(0, 20);
            const dateGroups: { key: string; label: string; events: CalendarEvent[] }[] = [];
            listEvents.forEach((event) => {
              const dayKey = format(event.start, "yyyy-MM-dd");
              let label: string;
              if (isSameDay(event.start, today)) label = "Today";
              else if (isSameDay(event.start, tomorrow)) label = "Tomorrow";
              else label = format(event.start, "EEE, MMM d");
              const existing = dateGroups.find(g => g.key === dayKey);
              if (existing) existing.events.push(event);
              else dateGroups.push({ key: dayKey, label, events: [event] });
            });
            return (
            <div className="space-y-4">
            <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] overflow-hidden">
              <div className="px-4 py-3 border-b border-border/20 flex items-center justify-between">
                <h3 className="text-sm font-heading text-foreground" data-testid="text-list-header">Upcoming Appointments</h3>
                <span className="text-xs text-muted-foreground">{listEvents.length} total</span>
              </div>
              {listEvents.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground text-sm">No upcoming appointments.</div>
              ) : (
                <div>
                  {dateGroups.map((group) => (
                    <div key={group.key}>
                      <div className="px-4 py-2 bg-muted/30 border-b border-border/10">
                        <span className="text-[11px] font-heading uppercase tracking-wider text-muted-foreground">{group.label}</span>
                      </div>
                      {group.events.map((event) => {
                        const isPending = event.resource?.status === "PENDING";
                        const barColor = isPending ? "hsl(var(--brand-warning))" : "hsl(var(--primary))";
                        const bgColor = isPending ? "hsl(var(--brand-warning) / 0.06)" : "hsl(var(--primary) / 0.03)";
                        const textColor = isPending ? "hsl(var(--brand-warning))" : "hsl(var(--primary))";
                        return (
                          <button
                            key={event.id}
                            onClick={() => setSelectedBooking(event.resource)}
                            className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/40 transition-colors text-left cursor-pointer border-b border-border/10 last:border-b-0"
                            style={{ backgroundColor: bgColor }}
                            data-testid={`list-item-${event.id}`}
                          >
                            <div className="w-[3px] self-stretch rounded-full shrink-0" style={{ backgroundColor: barColor }} />
                            <div className="flex-1 min-w-0">
                              <p className="font-heading text-[13px] truncate" style={{ color: textColor }}>{event.title}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {format(event.start, "h:mm a")} – {format(event.end, "h:mm a")} · {event.resource?.duration || 30}min
                              </p>
                            </div>
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-ui ${
                              isPending
                                ? "bg-[hsl(var(--brand-warning)/0.08)] text-[hsl(var(--brand-warning))] border border-[hsl(var(--brand-warning)/0.3)]"
                                : "bg-[hsl(var(--brand-success)/0.08)] text-[hsl(var(--brand-success))] border border-[hsl(var(--brand-success)/0.3)]"
                            }`}>
                              {isPending ? "Pending" : event.resource?.status}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </Card>
            {(() => {
              const filteredPastEvents = pastEvents.filter((event) => {
                const recInfo = recordingsByBookingId[event.id];
                if (pastMeetingsTab === "recordings") return recInfo?.recording?.status === "ready";
                if (pastMeetingsTab === "transcripts") return recInfo?.recording?.transcriptStatus === "ready";
                return true;
              });
              const recordingsCount = pastEvents.filter(e => recordingsByBookingId[e.id]?.recording?.status === "ready").length;
              const transcriptsCount = pastEvents.filter(e => recordingsByBookingId[e.id]?.recording?.transcriptStatus === "ready").length;
              const filteredPastDateGroups: { key: string; label: string; events: CalendarEvent[] }[] = [];
              filteredPastEvents.forEach((event) => {
                const dayKey = format(event.start, "yyyy-MM-dd");
                const label = isSameDay(event.start, today) ? "Today" : format(event.start, "EEE, MMM d");
                const existing = filteredPastDateGroups.find(g => g.key === dayKey);
                if (existing) existing.events.push(event);
                else filteredPastDateGroups.push({ key: dayKey, label, events: [event] });
              });
              const tabs = [
                { key: "meetings" as const, label: "Past Meetings", icon: Calendar, count: pastEvents.length },
                { key: "recordings" as const, label: "Recordings", icon: Video, count: recordingsCount },
                { key: "transcripts" as const, label: "Transcripts", icon: FileText, count: transcriptsCount },
              ];
              return (
              <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] overflow-hidden">
                <div className="px-4 py-3 border-b border-border/20">
                  <div className="flex gap-1 bg-muted/30 p-1 rounded-[var(--radius)] w-fit" data-testid="past-meetings-tabs">
                    {tabs.map((tab) => {
                      const Icon = tab.icon;
                      const isActive = pastMeetingsTab === tab.key;
                      return (
                        <button
                          key={tab.key}
                          onClick={() => setPastMeetingsTab(tab.key)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius)] text-xs font-ui transition-colors ${
                            isActive
                              ? "bg-primary text-primary-foreground shadow-sm"
                              : "hover:text-foreground"
                          }`}
                          style={isActive ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}
                          data-testid={`tab-${tab.key}`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {tab.label}
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                            isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted"
                          }`} style={isActive ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}>{tab.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {filteredPastEvents.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">
                    {pastMeetingsTab === "recordings" ? "No recordings yet." : pastMeetingsTab === "transcripts" ? "No transcripts yet." : "No past meetings."}
                  </div>
                ) : (
                  <div>
                    {filteredPastDateGroups.map((group) => (
                      <div key={group.key}>
                        <div className="px-4 py-2 bg-muted/30 border-b border-border/10">
                          <span className="text-[11px] font-heading uppercase tracking-wider text-muted-foreground">{group.label}</span>
                        </div>
                        {group.events.map((event) => {
                          const recInfo = recordingsByBookingId[event.id];
                          const hasRecording = recInfo?.recording?.status === "ready";
                          const hasTranscript = recInfo?.recording?.transcriptStatus === "ready";
                          return (
                            <button
                              key={event.id}
                              onClick={() => setSelectedBooking(event.resource)}
                              className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/40 transition-colors text-left cursor-pointer border-b border-border/10 last:border-b-0"
                              data-testid={`past-list-item-${event.id}`}
                            >
                              <div className="w-[3px] self-stretch rounded-full shrink-0 bg-primary/30" />
                              <div className="flex-1 min-w-0">
                                <p className="font-heading text-[13px] truncate text-foreground">{event.title}</p>
                                <p className="text-xs text-muted-foreground/70 mt-0.5">
                                  {format(event.start, "h:mm a")} – {format(event.end, "h:mm a")} · {event.resource?.duration || 30}min
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                {hasRecording && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-ui bg-accent/10 text-accent-foreground border border-accent/30" data-testid={`badge-recording-${event.id}`}>
                                    <Video className="w-3 h-3" />
                                    Recording
                                  </span>
                                )}
                                {hasTranscript && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-ui bg-accent/10 text-accent-foreground border border-accent/30" data-testid={`badge-transcript-${event.id}`}>
                                    <FileText className="w-3 h-3" />
                                    Transcript
                                  </span>
                                )}
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-ui bg-primary/10 text-primary border border-primary/20">
                                  Completed
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              );
            })()}
            </div>
            );
          })() : (
            <Card ref={calendarWrapperRef} className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] p-2 calendar-wrapper">
              <BigCalendar
                localizer={localizer}
                events={events}
                startAccessor="start"
                endAccessor="end"
                date={currentDate}
                onNavigate={setCurrentDate}
                view={view as any}
                onView={(v) => setView(v)}
                views={{ day: true, week: true, month: true, [MULTI_DAY_KEY]: MultiDayView } as any}
                selectable
                onSelectSlot={handleSelectSlot}
                onSelectEvent={handleSelectEvent}
                eventPropGetter={eventStyleGetter}
                formats={calendarFormats}
                style={{ height: view === Views.MONTH ? 700 : 1750 }}
                toolbar={false}
                step={15}
                timeslots={4}
                dayLayoutAlgorithm="no-overlap"
              />
            </Card>
          )}
        </div>

        {!showList && (
          <div className="hidden lg:block w-full lg:w-[340px] shrink-0 space-y-3">
            <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)]">
              <MiniCalendar
                currentDate={currentDate}
                onDateSelect={(d) => { setCurrentDate(d); setView(Views.DAY); }}
                events={events}
              />
            </Card>

            {pendingBookings.length > 0 && (
              <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--brand-warning))] animate-pulse" />
                  <h3 className="text-[11px] font-heading text-[hsl(var(--brand-warning))] uppercase tracking-wider">
                    Pending ({pendingBookings.length})
                  </h3>
                </div>
                <div className="space-y-2">
                  {pendingBookings.map((b: any) => {
                    const start = new Date(b.scheduledAt);
                    return (
                      <PendingBookingCard key={b.id} booking={b} start={start} onSelect={setSelectedBooking} readOnly={isParentUser} />
                    );
                  })}
                </div>
              </Card>
            )}

            <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] overflow-hidden">
              <div className="px-3 py-2.5 border-b border-border/20">
                <div className="flex gap-0.5 bg-muted/30 p-0.5 rounded-[var(--radius)]" data-testid="sidebar-tabs">
                  {([
                    { key: "upcoming" as const, label: "Upcoming", icon: CalendarClock, count: upcomingBookings.length },
                    { key: "past" as const, label: "Past", icon: Clock, count: sidebarPastBookings.length },
                    { key: "recordings" as const, label: "Recordings", icon: Video, count: sidebarRecordingsCount },
                    { key: "transcripts" as const, label: "Transcripts", icon: FileText, count: sidebarTranscriptsCount },
                  ]).map((tab) => {
                    const Icon = tab.icon;
                    const isActive = sidebarTab === tab.key;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => setSidebarTab(tab.key)}
                        className={`flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-[var(--radius)] text-[10px] font-ui transition-colors ${
                          isActive
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "hover:text-foreground"
                        }`}
                        style={isActive ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}
                        data-testid={`sidebar-tab-${tab.key}`}
                      >
                        <Icon className="w-3 h-3" />
                        <span className="hidden xl:inline">{tab.label}</span>
                        {tab.count > 0 && (
                          <span className={`text-[9px] px-1 py-0.5 rounded-full leading-none ${
                            isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted"
                          }`} style={isActive ? undefined : { color: 'var(--tab-color, hsl(var(--primary)))' }}>{tab.count}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="p-3">
                {sidebarTab === "upcoming" && (
                  <>
                    {groupedUpcoming.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">No upcoming appointments.</p>
                    ) : (
                      <div className="space-y-4">
                        {groupedUpcoming.map((group) => (
                          <div key={group.date}>
                            <div className="flex items-baseline gap-2 mb-2">
                              <span className={`text-[11px] font-heading uppercase tracking-wider ${
                                group.label === "TODAY" ? "text-primary" : "text-muted-foreground"
                              }`}>
                                {group.label}
                              </span>
                              <span className="text-[10px] text-muted-foreground/60">
                                {format(new Date(group.date + "T12:00:00"), "M/d/yyyy")}
                              </span>
                            </div>
                            <div className="space-y-1">
                              {group.items.map((b: any) => {
                                const start = new Date(b.scheduledAt);
                                const end = new Date(start.getTime() + (b.duration || 30) * 60 * 1000);
                                return (
                                  <button
                                    key={b.id}
                                    onClick={() => setSelectedBooking(b)}
                                    className="w-full text-left flex items-stretch gap-2.5 rounded-[var(--radius)] px-2.5 py-2 bg-primary/[0.04] hover:bg-primary/10 transition-colors cursor-pointer group"
                                    data-testid={`upcoming-${b.id}`}
                                  >
                                    <div className="w-[3px] self-stretch rounded-full shrink-0 bg-primary" />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-[13px] font-heading text-primary truncate group-hover:text-primary/80 transition-colors">
                                        {b.subject || b.attendeeName || "Appointment"}
                                      </p>
                                      <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[11px] text-muted-foreground">
                                          {format(start, "h:mm a")} – {format(end, "h:mm a")}
                                        </span>
                                        {b.meetingType === "video" && b.meetingUrl && (
                                          <Video className="w-3 h-3 text-muted-foreground/50" />
                                        )}
                                      </div>
                                    </div>
                                    {b.status === "CONFIRMED" && b.providerUser?.dailyRoomUrl && b.meetingType !== "phone" && (
                                      <a
                                        href={`/room/${b.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="self-center shrink-0 inline-flex items-center gap-1 rounded-[var(--radius)] px-2 py-1 text-[10px] font-ui bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                                        data-testid={isParentUser ? `button-join-meeting-upcoming-${b.id}` : `button-start-meeting-upcoming-${b.id}`}
                                      >
                                        <Video className="w-3 h-3" />
                                        {isParentUser ? "Join" : "Start"}
                                      </a>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {(sidebarTab === "past" || sidebarTab === "recordings" || sidebarTab === "transcripts") && (
                  <>
                    {sidebarPastFiltered.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        {sidebarTab === "recordings" ? "No recordings yet." : sidebarTab === "transcripts" ? "No transcripts yet." : "No past meetings."}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {sidebarPastFiltered.map((b: any) => {
                          const start = new Date(b.scheduledAt);
                          const end = new Date(start.getTime() + (b.duration || 30) * 60 * 1000);
                          const recInfo = recordingsByBookingId[b.id];
                          const hasRecording = recInfo?.recording?.status === "ready";
                          const hasTranscript = recInfo?.recording?.transcriptStatus === "ready";
                          return (
                            <button
                              key={b.id}
                              onClick={() => setSelectedBooking(b)}
                              className="w-full text-left flex items-stretch gap-2.5 rounded-[var(--radius)] px-2.5 py-2 hover:bg-muted/40 transition-colors cursor-pointer group"
                              data-testid={`sidebar-past-${b.id}`}
                            >
                              <div className="w-[3px] self-stretch rounded-full shrink-0 bg-primary/30" />
                              <div className="min-w-0 flex-1">
                                <p className="text-[13px] font-heading text-foreground truncate group-hover:text-primary transition-colors">
                                  {b.subject || b.attendeeName || "Appointment"}
                                </p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[11px] text-muted-foreground/70">
                                    {format(start, "MMM d")} · {format(start, "h:mm a")} – {format(end, "h:mm a")}
                                  </span>
                                </div>
                                {(hasRecording || hasTranscript) && (
                                  <div className="flex items-center gap-1.5 mt-1">
                                    {hasRecording && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-ui bg-accent/10 text-accent-foreground border border-accent/30">
                                        <Video className="w-2.5 h-2.5" />
                                        Recording
                                      </span>
                                    )}
                                    {hasTranscript && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-ui bg-accent/10 text-accent-foreground border border-accent/30">
                                        <FileText className="w-2.5 h-2.5" />
                                        Transcript
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </Card>

            <Card className="shadow-[0_1px_2px_rgba(0,0,0,0.07)] p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-heading text-muted-foreground uppercase tracking-wider">Legend</h3>
                {!isParentUser && (
                  <Link
                    to="/account/calendar"
                    className="text-[11px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
                    data-testid="link-calendar-settings"
                  >
                    <Settings className="w-3 h-3" />
                    Settings
                  </Link>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2.5 text-[13px]">
                  <div className="w-[3px] h-4 rounded-full shrink-0 bg-primary" />
                  <div className="w-3 h-3 rounded shrink-0 bg-primary" />
                  <span className="font-ui text-foreground">{companyName} Appointments</span>
                </div>
                {connections && connections.length > 0 ? (
                  connections.map((conn: any) => (
                    <div key={conn.id} className="flex items-center gap-2.5 text-[13px]">
                      <div className="w-[3px] h-4 rounded-full shrink-0" style={{ backgroundColor: conn.color }} />
                      <button
                        type="button"
                        className="relative w-3 h-3 rounded shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all"
                        style={{ backgroundColor: conn.color }}
                        onClick={() => document.getElementById(`color-legend-conn-${conn.id}`)?.click()}
                        data-testid={`button-legend-color-${conn.id}`}
                      />
                      <input
                        id={`color-legend-conn-${conn.id}`}
                        type="color"
                        value={conn.color}
                        onChange={(e) => updateConnectionColor(conn.id, e.target.value)}
                        className="sr-only"
                      />
                      <span className="font-ui truncate text-foreground">{conn.label || conn.provider}</span>
                    </div>
                  ))
                ) : (
                  <div className="flex items-center gap-2.5 text-[13px]">
                    <div className="w-[3px] h-4 rounded-full shrink-0" style={{ backgroundColor: colorExternal }} />
                    <div className="w-3 h-3 rounded shrink-0" style={{ backgroundColor: colorExternal }} />
                    <span className="font-ui text-foreground">External Calendar</span>
                  </div>
                )}
                {!isParentUser && (
                  <div className="flex items-center gap-2.5 text-[13px]">
                    <div className="w-[3px] h-4 rounded-full shrink-0" style={{ backgroundColor: colorBlocks }} />
                    <button
                      type="button"
                      className="relative w-3 h-3 rounded shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all"
                      style={{ backgroundColor: colorBlocks }}
                      onClick={() => document.getElementById("color-input-blocks")?.click()}
                      data-testid="button-color-blocks"
                    />
                    <input
                      id="color-input-blocks"
                      type="color"
                      value={colorBlocks}
                      onChange={(e) => updateCalendarColor("colorBlocks", e.target.value)}
                      className="sr-only"
                      data-testid="input-color-blocks"
                    />
                    <span className="font-ui text-foreground">Override Block</span>
                  </div>
                )}
                {!isParentUser && (
                  <div className="flex items-center gap-2.5 text-[13px]">
                    <div className="w-[3px] h-4 rounded-full shrink-0 bg-[hsl(var(--brand-success))]" />
                    <div className="w-3 h-3 rounded shrink-0 bg-[hsl(var(--brand-success))]" />
                    <span className="font-ui text-foreground">Override Available</span>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </div>
      )}

      {!isParentUser && <CreateAppointmentDialog open={createOpen} onClose={() => setCreateOpen(false)} config={config} />}
      {isParentUser && <ParentBookDialog open={parentBookOpen} onClose={() => setParentBookOpen(false)} />}
      <BookingDetailDialog booking={selectedBooking} open={!!selectedBooking} onClose={() => setSelectedBooking(null)} />

      {!isParentUser && (
        <Dialog open={!!selectedBlock} onOpenChange={(open) => !open && setSelectedBlock(null)}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>Edit Schedule Block</DialogTitle>
            </DialogHeader>
            {selectedBlock && (
              <BlockEditForm
                block={selectedBlock}
                onUpdate={(data) => updateBlockMutation.mutate({ id: selectedBlock._parentId || selectedBlock.id, data })}
                onDelete={() => deleteBlockMutation.mutate(selectedBlock._parentId || selectedBlock.id)}
                onClose={() => setSelectedBlock(null)}
                isUpdating={updateBlockMutation.isPending}
                isDeleting={deleteBlockMutation.isPending}
              />
            )}
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={!!selectedExternalEvent} onOpenChange={(open) => !open && setSelectedExternalEvent(null)}>
        <DialogContent className="sm:max-w-[420px]" data-testid="external-event-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              External Event
            </DialogTitle>
          </DialogHeader>
          {selectedExternalEvent && (() => {
            const ev = selectedExternalEvent;
            const providerLabel = ev.provider === "google" ? "Google Calendar" : ev.provider === "microsoft" ? "Outlook" : ev.provider === "apple" ? "Apple Calendar" : ev.provider;
            const baseId = getRecurringBaseId(ev.rawEventId);
            const isRecurring = !!baseId;
            const directOverride = (eventFreeOverrides || []).find((o: any) => o.provider === ev.provider && o.externalEventId === ev.rawEventId) || null;
            const seriesOverride = isRecurring ? (eventFreeOverrides || []).find((o: any) => o.provider === ev.provider && o.externalEventId === baseId) || null : null;
            const isSingleFree = !!directOverride;
            const isSeriesFree = !!seriesOverride;
            const isFree = isSingleFree || isSeriesFree;
            const isToggling = markEventFreeMutation.isPending || unmarkEventFreeMutation.isPending;

            return (
              <div className="space-y-4">
                <div>
                  <h3 className="font-heading text-base" data-testid="text-external-event-title">{ev.title}</h3>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
                    <Clock className="h-3.5 w-3.5" />
                    <span data-testid="text-external-event-time">
                      {format(ev.start, "EEE, MMM d")} &middot; {format(ev.start, "h:mm a")} – {format(ev.end, "h:mm a")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
                    <Link2 className="h-3.5 w-3.5" />
                    <span data-testid="text-external-event-source">
                      {ev.calendarLabel || providerLabel}
                    </span>
                  </div>
                  {isRecurring && (
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
                      <Repeat className="h-3.5 w-3.5" />
                      <span>Recurring event</span>
                    </div>
                  )}
                </div>

                {isRecurring ? (
                  <div className="border rounded-[var(--radius)] p-4 space-y-3">
                    <p className="text-sm font-ui">Availability Override</p>

                    <div className={`flex items-center justify-between rounded-[var(--radius)] px-3 py-2.5 ${isSingleFree ? "bg-[hsl(var(--brand-success)/0.08)] dark:bg-[hsl(var(--brand-success)/0.15)] border border-[hsl(var(--brand-success)/0.3)] dark:border-[hsl(var(--brand-success)/0.3)]" : "bg-muted/30 border"}`}>
                      <div className="flex items-center gap-2">
                        {isSingleFree ? <Check className="h-4 w-4 text-[hsl(var(--brand-success))]" /> : <X className="h-4 w-4 text-muted-foreground" />}
                        <div>
                          <p className="text-sm font-ui" data-testid="text-single-override-label">This occurrence</p>
                          <p className="text-xs text-muted-foreground">
                            {isSingleFree ? "Won't block scheduling" : "Blocks scheduling"}
                          </p>
                        </div>
                      </div>
                      <button
                        data-testid="button-toggle-single-occurrence"
                        disabled={isToggling}
                        onClick={() => {
                          if (isSingleFree && directOverride) {
                            unmarkEventFreeMutation.mutate(directOverride.id);
                          } else {
                            markEventFreeMutation.mutate({
                              externalEventId: ev.rawEventId,
                              provider: ev.provider,
                              calendarId: ev.calendarId,
                              title: ev.title,
                            });
                          }
                        }}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${isSingleFree ? "bg-[hsl(var(--brand-success))]" : "bg-muted"} ${isToggling ? "opacity-50" : ""}`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${isSingleFree ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>

                    <div className={`flex items-center justify-between rounded-[var(--radius)] px-3 py-2.5 ${isSeriesFree ? "bg-[hsl(var(--brand-success)/0.08)] dark:bg-[hsl(var(--brand-success)/0.15)] border border-[hsl(var(--brand-success)/0.3)] dark:border-[hsl(var(--brand-success)/0.3)]" : "bg-muted/30 border"}`}>
                      <div className="flex items-center gap-2">
                        {isSeriesFree ? <Check className="h-4 w-4 text-[hsl(var(--brand-success))]" /> : <X className="h-4 w-4 text-muted-foreground" />}
                        <div>
                          <p className="text-sm font-ui" data-testid="text-series-override-label">All occurrences</p>
                          <p className="text-xs text-muted-foreground">
                            {isSeriesFree ? "Entire series won't block scheduling" : "Entire series blocks scheduling"}
                          </p>
                        </div>
                      </div>
                      <button
                        data-testid="button-toggle-all-occurrences"
                        disabled={isToggling}
                        onClick={() => {
                          if (isSeriesFree && seriesOverride) {
                            unmarkEventFreeMutation.mutate(seriesOverride.id);
                          } else {
                            markEventFreeMutation.mutate({
                              externalEventId: baseId!,
                              provider: ev.provider,
                              calendarId: ev.calendarId,
                              title: ev.title,
                            });
                          }
                        }}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${isSeriesFree ? "bg-[hsl(var(--brand-success))]" : "bg-muted"} ${isToggling ? "opacity-50" : ""}`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${isSeriesFree ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>

                    <div className={`flex items-center gap-2 text-sm rounded-[var(--radius)] px-3 py-2 ${isFree ? "bg-[hsl(var(--brand-success)/0.08)] text-[hsl(var(--brand-success))] dark:bg-[hsl(var(--brand-success)/0.15)] dark:text-[hsl(var(--brand-success))]" : "bg-muted/50 text-muted-foreground"}`}>
                      {isFree ? (
                        <>
                          <Check className="h-4 w-4" />
                          <span data-testid="text-availability-status">Available — won't block slots</span>
                        </>
                      ) : (
                        <>
                          <X className="h-4 w-4" />
                          <span data-testid="text-availability-status">Busy — blocks scheduling slots</span>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="border rounded-[var(--radius)] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-ui">Availability Override</p>
                        <p className="text-xs text-muted-foreground">
                          {isFree ? "This event won't block your scheduling" : "This event blocks your scheduling"}
                        </p>
                      </div>
                      <button
                        data-testid="button-toggle-event-availability"
                        disabled={isToggling}
                        onClick={() => {
                          if (isFree && directOverride) {
                            unmarkEventFreeMutation.mutate(directOverride.id);
                          } else {
                            markEventFreeMutation.mutate({
                              externalEventId: ev.rawEventId,
                              provider: ev.provider,
                              calendarId: ev.calendarId,
                              title: ev.title,
                            });
                          }
                        }}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${isFree ? "bg-[hsl(var(--brand-success))]" : "bg-muted"} ${isToggling ? "opacity-50" : ""}`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${isFree ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>
                    <div className={`flex items-center gap-2 text-sm rounded-[var(--radius)] px-3 py-2 ${isFree ? "bg-[hsl(var(--brand-success)/0.08)] text-[hsl(var(--brand-success))] dark:bg-[hsl(var(--brand-success)/0.15)] dark:text-[hsl(var(--brand-success))]" : "bg-muted/50 text-muted-foreground"}`}>
                      {isFree ? (
                        <>
                          <Check className="h-4 w-4" />
                          <span data-testid="text-availability-status">Available — won't block slots</span>
                        </>
                      ) : (
                        <>
                          <X className="h-4 w-4" />
                          <span data-testid="text-availability-status">Busy — blocks scheduling slots</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
