import { Calendar } from "lucide-react";
import { GoogleIcon, AppleIcon, MicrosoftIcon } from "@/components/calendar/calendar-provider-icons";

function googleCalUrl(bk: any) {
  const start = new Date(bk.scheduledAt);
  const end = new Date(start.getTime() + bk.duration * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: bk.subject || "Meeting",
    dates: `${fmt(start)}/${fmt(end)}`,
    details: bk.meetingUrl ? `Join: ${bk.meetingUrl}` : "",
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function outlookCalUrl(bk: any) {
  const start = new Date(bk.scheduledAt);
  const end = new Date(start.getTime() + bk.duration * 60 * 1000);
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: bk.subject || "Meeting",
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: bk.meetingUrl ? `Join: ${bk.meetingUrl}` : "",
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params}`;
}

function generateIcs(bk: any): string {
  const start = new Date(bk.scheduledAt);
  const end = new Date(start.getTime() + bk.duration * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/-|:|\./g, "").slice(0, 15) + "Z";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GoStork//EN", "BEGIN:VEVENT",
    `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${bk.subject || "Meeting"}`,
    bk.meetingUrl ? `DESCRIPTION:Join: ${bk.meetingUrl}` : "",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

function downloadIcs(bk: any) {
  const ics = generateIcs(bk);
  const blob = new Blob([ics], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "booking.ics";
  a.click();
  URL.revokeObjectURL(url);
}

export function AddToCalendarButtons({ booking }: { booking: any }) {
  return (
    <div className="flex flex-col gap-2" data-testid="add-to-calendar-section">
      <p className="t-helper font-heading mb-1">Add to Calendar</p>
      <a
        href={googleCalUrl(booking)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 w-full px-4 py-3 rounded-[var(--radius)] border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer"
        data-testid="link-add-google-cal"
      >
        <GoogleIcon className="w-5 h-5 shrink-0" />
        <span className="text-sm font-ui">Google Calendar</span>
      </a>
      <button
        type="button"
        onClick={() => downloadIcs(booking)}
        className="flex items-center gap-3 w-full px-4 py-3 rounded-[var(--radius)] border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer text-left"
        data-testid="button-add-apple-cal"
      >
        <AppleIcon className="w-5 h-5 shrink-0" />
        <span className="text-sm font-ui">Apple Calendar</span>
      </button>
      <a
        href={outlookCalUrl(booking)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 w-full px-4 py-3 rounded-[var(--radius)] border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer"
        data-testid="link-add-outlook-cal"
      >
        <MicrosoftIcon className="w-5 h-5 shrink-0" />
        <span className="text-sm font-ui">Outlook Calendar</span>
      </a>
      <button
        type="button"
        onClick={() => downloadIcs(booking)}
        className="flex items-center gap-3 w-full px-4 py-3 rounded-[var(--radius)] border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer text-left"
        data-testid="button-add-other-cal"
      >
        <Calendar className="w-5 h-5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-ui">Other Calendar</span>
      </button>
    </div>
  );
}
