import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, ChevronDown, ChevronUp, Loader2, Pause, Play, Search } from "lucide-react";

// ElevenLabs-style voice + avatar browsers for the admin persona form.
// Inline expandable panels (page tree, no modal/portal - project rule), with
// search, attribute filter chips, per-voice play buttons, and a large photo
// grid for avatars.

export interface VoiceOption {
  id: string;
  name: string;
  description?: string;
  gender?: string;
  age?: string;
  accent?: string;
  language?: string;
  previewUrl?: string;
}
export interface AvatarOption {
  id: string;
  name: string;
  imageUrl?: string;
  kind: "custom" | "preset";
}

// Synthesize one sentence with the given provider/voice and play it. Throws
// on failure so the caller can toast the real error.
export async function playVoicePreview(provider: string, voiceId?: string): Promise<void> {
  const res = await fetch("/api/voice/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ provider, voiceId: voiceId || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Preview failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

function useVoiceCatalog(provider: string) {
  return useQuery<{ voices: VoiceOption[] }>({
    queryKey: ["/api/voice/options/voices", provider],
    queryFn: async () => (await apiRequest("GET", `/api/voice/options/voices?provider=${encodeURIComponent(provider)}`)).json(),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}
function useAvatarCatalog() {
  return useQuery<{ avatars: AvatarOption[] }>({
    queryKey: ["/api/voice/options/avatars"],
    queryFn: async () => (await apiRequest("GET", "/api/voice/options/avatars")).json(),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function FilterChips({
  label,
  values,
  selected,
  onSelect,
}: {
  label: string;
  values: string[];
  selected: string | null;
  onSelect: (v: string | null) => void;
}) {
  if (values.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="t-helper w-14 shrink-0">{label}</span>
      <button
        onClick={() => onSelect(null)}
        className={`px-2.5 py-1 rounded-full text-xs font-ui border transition-colors ${selected === null ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-secondary"}`}
      >
        All
      </button>
      {values.map((v) => (
        <button
          key={v}
          onClick={() => onSelect(selected === v ? null : v)}
          className={`px-2.5 py-1 rounded-full text-xs font-ui border transition-colors ${selected === v ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-secondary"}`}
        >
          {cap(v)}
        </button>
      ))}
    </div>
  );
}

export function VoicePicker({
  provider,
  value,
  onChange,
  testId,
}: {
  provider: string;
  value: string;
  onChange: (id: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<string | null>(null);
  const [age, setAge] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { data, isError } = useVoiceCatalog(provider);
  const voices = data?.voices || [];
  const selected = voices.find((v) => v.id === value);

  const distinct = (key: keyof VoiceOption) =>
    Array.from(new Set(voices.map((v) => (v[key] as string) || "").filter(Boolean)));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return voices.filter(
      (v) =>
        (!gender || v.gender === gender) &&
        (!age || v.age === age) &&
        (!accent || v.accent === accent) &&
        (!q || `${v.name} ${v.description || ""} ${v.accent || ""}`.toLowerCase().includes(q)),
    );
  }, [voices, query, gender, age, accent]);

  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  };

  const togglePlay = async (v: VoiceOption) => {
    if (playingId === v.id) {
      stopAudio();
      return;
    }
    stopAudio();
    try {
      if (v.previewUrl) {
        const audio = new Audio(v.previewUrl);
        audioRef.current = audio;
        audio.onended = () => setPlayingId(null);
        setPlayingId(v.id);
        await audio.play();
      } else {
        // No hosted sample (OpenAI/Cartesia) - synthesize one line server-side.
        setLoadingId(v.id);
        await playVoicePreview(provider, v.id);
        setLoadingId(null);
      }
    } catch {
      setLoadingId(null);
      setPlayingId(null);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        type="button"
        className="w-full justify-between font-normal"
        onClick={() => {
          setOpen(!open);
          if (open) stopAudio();
        }}
        data-testid={testId}
      >
        <span className="truncate flex items-center gap-2">
          {selected ? (
            <>
              <span>{selected.name}</span>
              {selected.gender && <span className="text-xs text-muted-foreground">{cap(selected.gender)}</span>}
              {selected.accent && <span className="text-xs text-muted-foreground">{cap(selected.accent)}</span>}
            </>
          ) : value ? (
            <span className="text-muted-foreground">Current: {value}</span>
          ) : (
            <span className="text-muted-foreground">{isError ? "Could not load voices" : "Choose a voice..."}</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 shrink-0 opacity-50" /> : <ChevronDown className="w-4 h-4 shrink-0 opacity-50" />}
      </Button>

      {open && (
        <div className="border rounded-[var(--radius)] p-3 space-y-3 bg-background" data-testid={`${testId}-panel`}>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search voices..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="space-y-1.5">
            <FilterChips label="Gender" values={distinct("gender")} selected={gender} onSelect={setGender} />
            <FilterChips label="Age" values={distinct("age")} selected={age} onSelect={setAge} />
            <FilterChips label="Accent" values={distinct("accent")} selected={accent} onSelect={setAccent} />
          </div>
          <div className="max-h-80 overflow-y-auto divide-y rounded-[var(--radius)] border">
            {filtered.length === 0 && (
              <p className="t-helper italic p-4 text-center">{voices.length ? "No voices match the filters." : "Loading voices..."}</p>
            )}
            {filtered.map((v) => (
              <div
                key={v.id}
                className={`flex items-center gap-3 p-2.5 cursor-pointer transition-colors ${v.id === value ? "bg-secondary/70" : "hover:bg-secondary/40"}`}
                onClick={() => {
                  onChange(v.id);
                  stopAudio();
                  setOpen(false);
                }}
                data-testid={`voice-option-${v.id}`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void togglePlay(v);
                  }}
                  className="w-9 h-9 shrink-0 rounded-full border flex items-center justify-center text-primary hover:bg-secondary transition-colors"
                  aria-label={`Play sample of ${v.name}`}
                >
                  {loadingId === v.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : playingId === v.id ? (
                    <Pause className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4 ml-0.5" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{v.name}</span>
                    {v.id === value && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 mt-0.5">
                    {v.description && <span className="t-helper truncate">{cap(v.description)}</span>}
                    {[v.gender, v.age, v.accent].filter(Boolean).map((t) => (
                      <span key={t} className="text-xs font-ui px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                        {cap(t!)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AvatarPicker({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (id: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string | null>(null);

  const { data, isError } = useAvatarCatalog();
  const avatars = data?.avatars || [];
  const selected = avatars.find((a) => a.id === value);
  const hasCustom = avatars.some((a) => a.kind === "custom");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return avatars.filter(
      (a) => (!kind || a.kind === kind) && (!q || a.name.toLowerCase().includes(q)),
    );
  }, [avatars, query, kind]);

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        type="button"
        className="w-full justify-between font-normal h-11"
        onClick={() => setOpen(!open)}
        data-testid={testId}
      >
        <span className="truncate flex items-center gap-2.5">
          {selected ? (
            <>
              {selected.imageUrl ? (
                <img src={selected.imageUrl} alt="" className="w-7 h-7 rounded-full object-cover border" />
              ) : (
                <span className="w-7 h-7 rounded-full bg-secondary" />
              )}
              <span>{selected.name}</span>
              {selected.kind === "custom" && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground font-ui">Custom</span>
              )}
            </>
          ) : value ? (
            <span className="text-muted-foreground">Current: {value}</span>
          ) : (
            <span className="text-muted-foreground">{isError ? "Could not load avatars" : "Choose an avatar..."}</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 shrink-0 opacity-50" /> : <ChevronDown className="w-4 h-4 shrink-0 opacity-50" />}
      </Button>

      {open && (
        <div className="border rounded-[var(--radius)] p-3 space-y-3 bg-background" data-testid={`${testId}-panel`}>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search avatars..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            {hasCustom && (
              <FilterChips label="" values={["custom", "preset"]} selected={kind} onSelect={setKind} />
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="t-helper italic p-4 text-center">{avatars.length ? "No avatars match." : "Loading avatars..."}</p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {filtered.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    onChange(a.id);
                    setOpen(false);
                  }}
                  className={`text-left rounded-[var(--radius)] border overflow-hidden transition-all hover:shadow-md ${a.id === value ? "ring-2 ring-primary border-primary" : ""}`}
                  data-testid={`avatar-option-${a.id}`}
                >
                  {a.imageUrl ? (
                    <img src={a.imageUrl} alt={a.name} className="w-full aspect-video object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full aspect-video bg-secondary" />
                  )}
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    <span className="text-xs font-ui truncate flex-1">{a.name}</span>
                    {a.kind === "custom" && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground font-ui shrink-0">Custom</span>
                    )}
                    {a.id === value && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
