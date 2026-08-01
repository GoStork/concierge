import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

// Realtime avatar video: joins the LiveAvatar LiveKit room and attaches the
// avatar's video + audio tracks. livekit-client is dynamically imported so the
// (large) WebRTC bundle only loads when avatar mode is actually on. On any
// failure the parent falls back to the static persona image; audio still flows
// through the LiveKit audio track (server routes speech to the avatar session
// while it is active), so a video-element failure is loud, not silent.

export function AvatarVideo({
  livekitUrl,
  livekitToken,
  brandColor,
  onFailed,
}: {
  livekitUrl: string;
  livekitToken: string;
  brandColor: string;
  onFailed: (reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let room: any = null;
    let cancelled = false;
    (async () => {
      try {
        const { Room, RoomEvent, Track } = await import("livekit-client");
        room = new Room({ adaptiveStream: true });
        const attach = (track: any) => {
          if (cancelled) return;
          if (track.kind === Track.Kind.Video && videoRef.current) {
            track.attach(videoRef.current);
            setConnected(true);
          } else if (track.kind === Track.Kind.Audio && audioRef.current) {
            track.attach(audioRef.current);
          }
        };
        room.on(RoomEvent.TrackSubscribed, (track: any) => attach(track));
        await room.connect(livekitUrl, livekitToken);
        // Attach any tracks that were already published before we joined.
        for (const participant of room.remoteParticipants.values()) {
          for (const pub of participant.trackPublications.values()) {
            if (pub.track) attach(pub.track);
          }
        }
      } catch (err: any) {
        console.error(`[voice] avatar video failed: ${err?.message}`);
        if (!cancelled) onFailed(err?.message || "LiveKit connection failed");
      }
    })();
    return () => {
      cancelled = true;
      try {
        room?.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livekitUrl, livekitToken]);

  return (
    <div
      className="relative w-56 h-56 sm:w-64 sm:h-64 rounded-[var(--radius)] overflow-hidden border-4 flex items-center justify-center bg-muted"
      style={{ borderColor: brandColor }}
      data-testid="voice-avatar-video"
    >
      {!connected && <Loader2 className="w-6 h-6 animate-spin text-muted-foreground absolute" />}
      <video ref={videoRef} autoPlay playsInline muted={false} className="w-full h-full object-cover" />
      <audio ref={audioRef} autoPlay />
    </div>
  );
}
