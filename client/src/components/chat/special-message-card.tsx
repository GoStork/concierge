import { getPhotoSrc } from "@/lib/profile-utils";
import { CheckCircle2, FileText, Download, Video, CalendarDays, ExternalLink, UserCheck, Receipt, Paperclip } from "lucide-react";
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
            <p className="text-xs text-muted-foreground">
              {data.providerName === "GoStork"
                ? `Schedule GoStork Concierge Call with ${data.memberName || "GoStork Team"}`
                : data.memberName ? `Schedule with ${data.memberName}` : "Pick a time that works for you"}
            </p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  if (msg.uiCardType === "signer_signed") {
    const signerName = data.signerName || "Signer";
    return (
      <div className="mt-1" data-testid="signer-signed-card">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <UserCheck className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{signerName} Signed</p>
            <p className="text-xs text-muted-foreground">Has signed the agreement</p>
          </div>
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: brandColor }} />
        </div>
      </div>
    );
  }

  if (msg.uiCardType === "agreement_signed") {
    const agreementId = data.agreementId;
    return (
      <div className="mt-1" data-testid="agreement-signed-card">
        <a
          href={agreementId ? `/api/agreements/${agreementId}/download` : "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Agreement Fully Signed</p>
            <p className="text-xs text-muted-foreground">Click to download the signed PDF</p>
          </div>
          <Download className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  if (msg.uiCardType === "cost_sheet") {
    const totalCents: number = data.totalCostCents ?? 0;
    const fileUrl: string | null = data.costSheetFileUrl || null;
    const fileName: string | null = data.costSheetFileName || null;
    const providerName: string = data.providerName || "Your provider";
    const notes: string | null = data.notes || null;
    const sentAt: string | null = data.sentAt || null;
    const totalFormatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totalCents / 100);

    return (
      <div className="mt-1" data-testid="cost-sheet-card">
        <div
          className="rounded-[var(--radius)] border-2 bg-background overflow-hidden"
          style={{ borderColor: brandColor }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0"
              style={{ backgroundColor: brandColor }}
            >
              <Receipt className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Cost Sheet from {providerName}</p>
              <p className="text-xs text-muted-foreground">
                Total quoted cost
                {sentAt ? ` - ${new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-lg font-bold" style={{ color: brandColor }}>{totalFormatted}</p>
            </div>
          </div>
          {(fileUrl || notes) && (
            <div className="border-t px-4 py-2.5 space-y-2 bg-muted/30">
              {fileUrl && (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs hover:underline"
                  style={{ color: brandColor }}
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  {fileName || "Open cost sheet"}
                </a>
              )}
              {notes && <p className="text-xs text-muted-foreground italic">{notes}</p>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
