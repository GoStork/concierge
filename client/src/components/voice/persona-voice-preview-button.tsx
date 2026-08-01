import { useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings } from "@/hooks/use-brand-settings";

// "Hear this persona" pill for the persona-selection cards (parent
// registration, parent + provider settings). Plays the persona's configured
// voice for the active provider via the cached, auth-only
// /api/voice/persona-preview endpoint. Renders nothing when voice mode is off.
export function PersonaVoicePreviewButton({
  matchmakerId,
  personaName,
  brandColor,
  className = "",
}: {
  matchmakerId: string;
  personaName: string;
  brandColor?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const { data: brand } = useBrandSettings();
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  if (!(brand as any)?.voiceModeEnabled) return null;

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  };

  const onClick = async (e: React.MouseEvent) => {
    // Cards select on click - hearing a voice must not switch personas.
    e.stopPropagation();
    e.preventDefault();
    if (playing) {
      stop();
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/voice/persona-preview?matchmakerId=${encodeURIComponent(matchmakerId)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Preview failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(false);
      };
      setPlaying(true);
      await audio.play();
    } catch (err: any) {
      setPlaying(false);
      toast({ title: "Could not play voice", description: err?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-ui transition-colors hover:bg-secondary ${className}`}
      style={brandColor ? { borderColor: `${brandColor}55`, color: brandColor } : undefined}
      aria-label={`Hear ${personaName}'s voice`}
      data-testid={`btn-hear-persona-${matchmakerId}`}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : playing ? (
        <Pause className="w-3.5 h-3.5" />
      ) : (
        <Play className="w-3.5 h-3.5" />
      )}
      Hear {personaName}
    </button>
  );
}
