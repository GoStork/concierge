import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

// Realtime avatar video: joins the LiveAvatar LiveKit room and attaches the
// avatar's video + audio tracks. livekit-client is dynamically imported so the
// (large) WebRTC bundle only loads when avatar mode is actually on. On any
// failure the parent falls back to the static persona image; audio still flows
// through the LiveKit audio track (server routes speech to the avatar session
// while it is active), so a video-element failure is loud, not silent.
//
// LiveAvatar LITE streams the avatar on a chroma-key GREEN background - it is
// meant to be keyed out by the client. The video is therefore drawn through a
// canvas that removes the green (with edge softening + despill) so the avatar
// sits directly on the brand surface instead of a green rectangle.

// Processing resolution for the chroma key. The source is 720p; keying at
// 480px square (the display is ~224-256px) keeps the per-frame pixel loop
// cheap on phones while staying sharper than the displayed size.
const KEY_SIZE = 480;

function startChromaKey(video: HTMLVideoElement, out: HTMLCanvasElement): () => void {
  const ctx = out.getContext("2d", { willReadFrequently: false })!;
  const work = document.createElement("canvas");
  work.width = KEY_SIZE;
  work.height = KEY_SIZE;
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  out.width = KEY_SIZE;
  out.height = KEY_SIZE;

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    // Center-crop a square from the source (same as object-cover).
    const s = Math.min(vw, vh);
    const sx = (vw - s) / 2;
    const sy = (vh - s) / 2;
    wctx.drawImage(video, sx, sy, s, s, 0, 0, KEY_SIZE, KEY_SIZE);
    const frame = wctx.getImageData(0, 0, KEY_SIZE, KEY_SIZE);
    const px = frame.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // Greenness = how much green exceeds the strongest other channel.
      const other = r > b ? r : b;
      const greenness = g - other;
      if (greenness > 12) {
        // Soft ramp: fully transparent by greenness ~60, partial below.
        const a = Math.max(0, 255 - (greenness - 12) * 6);
        px[i + 3] = a;
        // Despill: pull the green channel down so semi-transparent edge
        // pixels (hair) don't glow green over the page background.
        px[i + 1] = other;
      }
    }
    ctx.clearRect(0, 0, KEY_SIZE, KEY_SIZE);
    ctx.putImageData(frame, 0, 0);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let room: any = null;
    let cancelled = false;
    let stopKey: (() => void) | null = null;
    (async () => {
      try {
        const { Room, RoomEvent, Track } = await import("livekit-client");
        room = new Room({ adaptiveStream: true });
        const attach = (track: any) => {
          if (cancelled) return;
          if (track.kind === Track.Kind.Video && videoRef.current && canvasRef.current) {
            track.attach(videoRef.current);
            stopKey?.();
            stopKey = startChromaKey(videoRef.current, canvasRef.current);
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
      stopKey?.();
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
      className="relative w-56 h-56 sm:w-64 sm:h-64 rounded-[var(--radius)] overflow-hidden border-4 flex items-center justify-center bg-secondary"
      style={{ borderColor: brandColor }}
      data-testid="voice-avatar-video"
    >
      {!connected && <Loader2 className="w-6 h-6 animate-spin text-muted-foreground absolute" />}
      {/* Raw green-screen source stays out of sight (not display:none - some
          browsers throttle decoding of hidden videos); the keyed canvas is
          what the parent sees. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute w-px h-px opacity-0 pointer-events-none"
      />
      <canvas ref={canvasRef} className="w-full h-full" />
      <audio ref={audioRef} autoPlay />
    </div>
  );
}
