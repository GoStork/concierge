import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { analyzeRemoteTrack } from "@/lib/voice/remote-level";
import { reportVoiceClientMetric } from "@/hooks/use-voice-session";

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

// Cap on the chroma-key processing resolution (longest edge). Keying keeps
// the source aspect ratio - CSS object-cover does the cropping - so the same
// canvas works for the small card and the full-bleed FaceTime layout.
const KEY_MAX_DIM = 720;

function startChromaKey(video: HTMLVideoElement, out: HTMLCanvasElement): () => void {
  const ctx = out.getContext("2d", { willReadFrequently: false })!;
  const work = document.createElement("canvas");
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  let kw = 0;
  let kh = 0;

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    if (!kw) {
      const scale = Math.min(1, KEY_MAX_DIM / Math.max(vw, vh));
      kw = Math.round(vw * scale);
      kh = Math.round(vh * scale);
      work.width = kw;
      work.height = kh;
      out.width = kw;
      out.height = kh;
    }
    wctx.drawImage(video, 0, 0, vw, vh, 0, 0, kw, kh);
    const frame = wctx.getImageData(0, 0, kw, kh);
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
    ctx.clearRect(0, 0, kw, kh);
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
  fullBleed = false,
}: {
  livekitUrl: string;
  livekitToken: string;
  brandColor: string;
  onFailed: (reason: string) => void;
  // FaceTime-style immersive layout: fill the parent completely, no card
  // frame - the panel overlays name/captions/controls on top.
  fullBleed?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let room: any = null;
    let cancelled = false;
    let stopKey: (() => void) | null = null;
    let stopLevel: (() => void) | null = null;
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
            // Feed the avatar's output level to the echo-aware barge detector
            // (iOS AEC does not cancel this audio from the mic).
            if (track.mediaStreamTrack) {
              stopLevel?.();
              stopLevel = analyzeRemoteTrack(track.mediaStreamTrack);
            }
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
      stopLevel?.();
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
      className={
        fullBleed
          ? "absolute inset-0 overflow-hidden flex items-center justify-center bg-secondary"
          : "relative w-56 h-56 sm:w-64 sm:h-64 rounded-[var(--radius)] overflow-hidden border-4 flex items-center justify-center bg-secondary"
      }
      style={fullBleed ? undefined : { borderColor: brandColor }}
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
      <canvas ref={canvasRef} className="w-full h-full object-cover" />
      {/* Instrumentation: 'playing' marks when the LiveKit audio element
          actually starts rendering the avatar's audio in this browser. */}
      <audio ref={audioRef} autoPlay onPlaying={() => reportVoiceClientMetric("livekit_audio_element_playing")} />
    </div>
  );
}
