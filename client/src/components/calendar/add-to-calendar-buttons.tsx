import { Calendar } from "lucide-react";

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className}>
      <path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107"/>
      <path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00"/>
      <path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50"/>
      <path d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2"/>
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#333333">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
    </svg>
  );
}

function MicrosoftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <rect x="1" y="1" width="10.5" height="10.5" fill="#f25022" />
      <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7fba00" />
      <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00a4ef" />
      <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#ffb900" />
    </svg>
  );
}

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
  const fmt = (d: Date) => d.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
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
      <p className="text-sm font-heading text-muted-foreground mb-1">Add to Calendar</p>
      <a
        href={googleCalUrl(booking)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer"
        data-testid="link-add-google-cal"
      >
        <GoogleIcon className="w-5 h-5 shrink-0" />
        <span className="text-sm font-ui">Google Calendar</span>
      </a>
      <button
        type="button"
        onClick={() => downloadIcs(booking)}
        className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer text-left"
        data-testid="button-add-apple-cal"
      >
        <AppleIcon className="w-5 h-5 shrink-0" />
        <span className="text-sm font-ui">Apple Calendar</span>
      </button>
      <a
        href={outlookCalUrl(booking)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer"
        data-testid="link-add-outlook-cal"
      >
        <MicrosoftIcon className="w-5 h-5 shrink-0" />
        <span className="text-sm font-ui">Outlook Calendar</span>
      </a>
      <button
        type="button"
        onClick={() => downloadIcs(booking)}
        className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-border/50 hover:border-primary/30 hover:bg-secondary/20 transition-colors cursor-pointer text-left"
        data-testid="button-add-other-cal"
      >
        <Calendar className="w-5 h-5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-ui">Other Calendar</span>
      </button>
    </div>
  );
}
