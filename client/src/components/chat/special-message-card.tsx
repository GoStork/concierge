import { getPhotoSrc } from "@/lib/profile-utils";
import { FileText, Download, Video, CalendarDays, ExternalLink } from "lucide-react";
import type { SessionMessage } from "./chat-types";

interface SpecialMessageCardProps {
  msg: SessionMessage;
  brandColor: string;
  viewerRole?: "provider" | "parent" | "admin";
  onOpenInlineVideo?: (bookingId: string) => void;
}

export function SpecialMessageCard({ msg, brandColor, viewerRole, onOpenInlineVideo }: SpecialMessageCardProps) {
  const data = msg.uiCardData as any;
  if (!data) return null;

  if (msg.uiCardType === "attachment") {
    const isImage = data.mimeType?.startsWith("image/");
    const fileUrl = getPhotoSrc(data.url) || data.url;
    return (
      <div className="mt-1" data-testid="attachment-card">
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
    const isProviderViewer = viewerRole === "provider";
    const videoBookingId = data.bookingId;
    if (!videoBookingId) {
      return (
        <div className="mt-1" data-testid="video-invite-card">
          <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-muted/50 w-full text-left opacity-60" style={{ borderColor: brandColor }}>
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground/70 shrink-0" style={{ backgroundColor: brandColor }}>
              <Video className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-muted-foreground">Video Call Ended</p>
              <p className="text-xs text-muted-foreground">This call session has expired</p>
            </div>
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
      <div className="mt-1" data-testid="video-invite-card">
        <button
          onClick={handleVideoClick}
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors cursor-pointer w-full text-left"
          style={{ borderColor: brandColor }}
          data-testid="button-video-invite"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <Video className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{isProviderViewer ? "Start Video Call" : "Join Video Call"}</p>
            <p className="text-xs text-muted-foreground">{isProviderViewer ? "Click to start the video consultation" : "Click to join the video consultation"}</p>
          </div>
          <Video className="w-4 h-4 text-muted-foreground shrink-0" />
        </button>
      </div>
    );
  }

  if (msg.uiCardType === "calendar_share") {
    return (
      <div className="mt-1" data-testid="calendar-share-card">
        <a
          href={data.bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <CalendarDays className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Book a Meeting</p>
            <p className="text-xs text-muted-foreground">{data.memberName ? `Schedule with ${data.memberName}` : "Pick a time that works for you"}</p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  return null;
}
