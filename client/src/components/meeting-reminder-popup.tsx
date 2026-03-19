import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImminentBooking {
  id: string;
  subject: string | null;
  scheduledAt: string;
  duration: number;
  meetingUrl: string | null;
  meetingType: string;
  providerName: string;
  providerLogo: string | null;
  providerUserName: string | null;
  parentName: string;
  counterpartyName: string;
  isProvider: boolean;
}

const DISMISSED_KEY = "gostork_dismissed_meetings";
const POLL_INTERVAL = 30000;

function getDismissedIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function dismissBooking(id: string) {
  const dismissed = getDismissedIds();
  dismissed.add(id);
  sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
}

export function MeetingReminderPopup() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [booking, setBooking] = useState<ImminentBooking | null>(null);
  const [visible, setVisible] = useState(false);
  const brandColor = brand?.primaryColor || "#26584A";

  const isOnVideoPage = location.pathname.startsWith("/video/") || location.pathname.startsWith("/room/");

  const checkImminent = useCallback(async () => {
    if (!user || isOnVideoPage) return;
    try {
      const res = await fetch("/api/calendar/bookings/imminent", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.booking && !getDismissedIds().has(data.booking.id)) {
        setBooking(data.booking);
        setVisible(true);
      } else if (!data.booking) {
        setBooking(null);
        setVisible(false);
      }
    } catch {
      setBooking(null);
      setVisible(false);
    }
  }, [user, isOnVideoPage]);

  useEffect(() => {
    checkImminent();
    const interval = setInterval(checkImminent, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkImminent]);

  const handleDismiss = () => {
    if (booking) dismissBooking(booking.id);
    setVisible(false);
    setBooking(null);
  };

  const handleJoin = async (withRecording: boolean) => {
    if (!booking) return;
    try {
      await fetch(`/api/video/consent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ bookingId: booking.id, consentGiven: withRecording }),
      });
    } catch {}
    dismissBooking(booking.id);
    setVisible(false);
    navigate(`/video/${booking.id}?consent=${withRecording ? "yes" : "no"}`);
  };

  if (!visible || !booking) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      data-testid="meeting-reminder-overlay"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleDismiss} />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-[90vw] max-w-[440px] p-8 flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-300"
        data-testid="meeting-reminder-popup"
      >
        <button
          onClick={handleDismiss}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
          data-testid="btn-dismiss-meeting-reminder"
        >
          <X className="w-5 h-5" />
        </button>

        <div
          className="w-14 h-14 rounded-full flex items-center justify-center mb-5"
          style={{ backgroundColor: `${brandColor}15` }}
        >
          <Video className="w-7 h-7" style={{ color: brandColor }} />
        </div>

        <h2 className="text-xl font-display font-semibold mb-2" data-testid="text-meeting-title">
          Record This Consultation?
        </h2>

        <p className="text-sm text-muted-foreground mb-1 leading-relaxed">
          This call will be recorded and transcribed. You'll get a link to rewatch the video and review the transcript anytime.
        </p>
        <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
          You can decline and still join without recording.
        </p>

        <Button
          className="w-full h-12 text-white font-medium gap-2 rounded-xl text-sm"
          style={{ backgroundColor: brandColor }}
          onClick={() => handleJoin(true)}
          data-testid="btn-record-and-join"
        >
          <Video className="w-4 h-4" />
          Yes, Record & Transcribe
        </Button>

        <button
          className="mt-4 text-sm text-muted-foreground hover:text-foreground font-medium transition-colors"
          onClick={() => handleJoin(false)}
          data-testid="btn-join-without-recording"
        >
          Join Without Recording
        </button>
      </div>
    </div>
  );
}