import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ui/confirm-bar";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { VoicePicker, AvatarPicker, playVoicePreview, type VoiceOption, type AvatarOption } from "@/components/admin/voice-pickers";
import {
  Sparkles,
  Plus,
  Pencil,
  Trash2,
  Upload,
  X,
  Loader2,
  GripVertical,
  MessageSquare,
  MessageCircleQuestion,
  Bot,
  ChevronDown,
  ChevronUp,
  Settings,
  Brain,
  Globe,
  FileText,
  Send,
  CheckCircle,
  AlertCircle,
  Mic,
  Volume2,
  Check,
  Video,
} from "lucide-react";
import ImageCropPreview from "@/components/image-crop-preview";

function SystemSettingsCard() {
  const { toast } = useToast();
  const { data: brandSettings } = useBrandSettings();
  const [parentExperienceMode, setParentExperienceMode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currentMode = parentExperienceMode ?? brandSettings?.parentExperienceMode ?? "MARKETPLACE_ONLY";

  const handleSelect = async (mode: string) => {
    if (mode === currentMode || saving) return;
    setParentExperienceMode(mode);
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/brand/settings", {
        parentExperienceMode: mode,
        enableAiConcierge: mode !== "MARKETPLACE_ONLY",
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setParentExperienceMode(null);
      toast({ title: "Parent experience mode saved" });
    } catch {
      setParentExperienceMode(null);
      toast({ title: "Failed to save settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="rounded-[var(--radius)] p-6" data-testid="card-system-settings">
      <div className="flex items-center gap-2.5 mb-1">
        <Settings className="w-5 h-5 text-primary" />
        <h3 className="font-display text-base font-semibold">Parent Experience Mode</h3>
      </div>
      <p className="t-helper mb-4">
        Controls what parents see after onboarding.
      </p>

      <div className="space-y-5">
        <div className="space-y-2">
          <div
            className="grid grid-cols-2 rounded-[var(--radius)] border border-border overflow-hidden sm:inline-grid sm:min-w-[320px]"
            role="radiogroup"
            aria-label="Parent Experience Mode"
            data-testid="radio-parent-mode"
          >
            {([
              ["CONCIERGE_FIRST", "AI First", "radio-concierge-first"],
              ["MARKETPLACE_ONLY", "Marketplace Only", "radio-marketplace-only"],
            ] as const).map(([value, label, testId]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={currentMode === value}
                onClick={() => handleSelect(value)}
                disabled={saving}
                className={`px-4 py-2 text-sm font-medium transition-colors disabled:opacity-70 ${
                  currentMode === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-foreground hover:bg-secondary"
                }`}
                data-testid={testId}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="t-helper">
            {currentMode === "CONCIERGE_FIRST"
              ? "Direct parents to Eva after onboarding"
              : "Skip Eva, direct parents to search"}
          </p>
        </div>
      </div>
    </Card>
  );
}

const TTS_PROVIDER_LABELS: Record<string, string> = {
  elevenlabs: "ElevenLabs (most human)",
  openai: "OpenAI (budget)",
  cartesia: "Cartesia (fastest)",
};
const STT_PROVIDER_LABELS: Record<string, string> = {
  google: "Google Cloud STT",
  deepgram: "Deepgram (budget)",
};

function VoiceSettingsCard() {
  const { toast } = useToast();
  const { data: brandSettings } = useBrandSettings();
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  // Which vendors actually have API keys on the server - unconfigured ones are
  // selectable-but-disabled with an honest "API key not set" label.
  // retry + refetch: a transient failure (e.g. a server restart mid-load) must
  // not freeze every provider into a stale "API key not set" state.
  const { data: providerStatus, isError: providerStatusError } = useQuery<{ tts: { name: string; configured: boolean }[]; stt: { name: string; configured: boolean }[] }>({
    queryKey: ["/api/voice/providers"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/voice/providers");
      return res.json();
    },
    retry: 2,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const val = (key: string, fallback: any) =>
    draft[key] !== undefined ? draft[key] : ((brandSettings as any)?.[key] ?? fallback);
  const set = (key: string, v: any) => setDraft((d) => ({ ...d, [key]: v }));
  const hasChanges = Object.keys(draft).length > 0;

  // Personas with NO voice saved for the currently selected provider. There
  // is deliberately no hardcoded fallback voice - the app asks the admin to
  // set one per persona, and voice sessions fail loudly until it's done.
  const selectedTts = val("voiceTtsProvider", "elevenlabs");
  const personasMissingVoice = ((brandSettings?.matchmakers || []) as Matchmaker[]).filter(
    (m) =>
      m.isActive &&
      !(m.voiceIds || {})[selectedTts] &&
      !(selectedTts === "elevenlabs" && m.voiceId),
  );

  // Tri-state: true/false once status is loaded, null while loading or on
  // error - "API key not set" must never appear just because the status
  // request hasn't succeeded yet.
  const ttsConfigured = (name: string): boolean | null =>
    providerStatus ? (providerStatus.tts?.find((p) => p.name === name)?.configured ?? false) : null;
  const sttConfigured = (name: string): boolean | null =>
    providerStatus ? (providerStatus.stt?.find((p) => p.name === name)?.configured ?? false) : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/brand/settings", draft);
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setDraft({});
      toast({ title: "Voice settings saved" });
    } catch {
      toast({ title: "Failed to save voice settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="rounded-[var(--radius)] p-6" data-testid="card-voice-settings">
      <div className="flex items-center gap-2.5 mb-1">
        <Mic className="w-5 h-5 text-primary" />
        <h3 className="font-display text-base font-semibold">Voice</h3>
      </div>
      <p className="t-helper mb-4">
        Live voice conversations with the AI Concierge. Provider changes apply to new voice sessions immediately - no restart needed.
      </p>

      <div className="space-y-5">
        <div className="flex items-center justify-between p-3 rounded-[var(--radius)] border">
          <div>
            <span className="text-sm font-medium">Voice mode</span>
            <p className="t-helper">Parents get a mic button in the Eva chat to start a voice conversation</p>
          </div>
          <Switch
            checked={val("voiceModeEnabled", false)}
            onCheckedChange={(checked) => set("voiceModeEnabled", checked)}
            data-testid="switch-voice-mode"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Voice provider (text-to-speech)</Label>
            <RadioGroup
              value={val("voiceTtsProvider", "elevenlabs")}
              onValueChange={(v) => set("voiceTtsProvider", v)}
              className="space-y-1.5"
              data-testid="radio-voice-tts-provider"
            >
              {Object.entries(TTS_PROVIDER_LABELS).map(([name, label]) => {
                const configured = ttsConfigured(name);
                const disabled = configured === false;
                return (
                  <label
                    key={name}
                    className={`flex items-center gap-2.5 p-2.5 rounded-[var(--radius)] border transition-colors ${disabled ? "opacity-55 cursor-not-allowed" : "cursor-pointer hover:bg-muted/30"}`}
                  >
                    <RadioGroupItem value={name} disabled={disabled} />
                    <span className="text-sm">{label}</span>
                    {configured === false && (
                      <span className="ml-auto text-xs text-muted-foreground font-ui">API key not set</span>
                    )}
                    {configured === null && (
                      <span className="ml-auto text-xs text-muted-foreground font-ui">{providerStatusError ? "status unavailable" : "checking..."}</span>
                    )}
                  </label>
                );
              })}
            </RadioGroup>
          </div>
          <div className="space-y-1.5">
            <Label>Transcription provider (speech-to-text)</Label>
            <RadioGroup
              value={val("voiceSttProvider", "google")}
              onValueChange={(v) => set("voiceSttProvider", v)}
              className="space-y-1.5"
              data-testid="radio-voice-stt-provider"
            >
              {Object.entries(STT_PROVIDER_LABELS).map(([name, label]) => {
                const configured = sttConfigured(name);
                const disabled = configured === false;
                return (
                  <label
                    key={name}
                    className={`flex items-center gap-2.5 p-2.5 rounded-[var(--radius)] border transition-colors ${disabled ? "opacity-55 cursor-not-allowed" : "cursor-pointer hover:bg-muted/30"}`}
                  >
                    <RadioGroupItem value={name} disabled={disabled} />
                    <span className="text-sm">{label}</span>
                    {configured === false && (
                      <span className="ml-auto text-xs text-muted-foreground font-ui">API key not set</span>
                    )}
                    {configured === null && (
                      <span className="ml-auto text-xs text-muted-foreground font-ui">{providerStatusError ? "status unavailable" : "checking..."}</span>
                    )}
                  </label>
                );
              })}
            </RadioGroup>
          </div>
        </div>

        <p className="t-helper">
          Switching the voice provider instantly switches every persona to its voice for that provider - each persona
          row below shows what it speaks with right now.
        </p>

        {val("voiceModeEnabled", false) && personasMissingVoice.length > 0 && (
          <div
            className="flex items-start gap-2.5 p-3 rounded-[var(--radius)] border border-[hsl(var(--brand-warning))]/40 bg-[hsl(var(--brand-warning))]/10"
            data-testid="voice-missing-personas-warning"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--brand-warning))]" />
            <div className="text-sm">
              <span className="font-medium">
                {personasMissingVoice.map((m) => m.name).join(" and ")} {personasMissingVoice.length === 1 ? "has" : "have"} no{" "}
                {TTS_PROVIDER_LABELS[selectedTts]?.split(" ")[0] || selectedTts} voice yet.
              </span>{" "}
              <span className="text-muted-foreground">
                There is no default - set a voice on each persona in the Personas section below, or parents starting a
                voice chat with {personasMissingVoice.length === 1 ? "this persona" : "these personas"} will get a
                "voice not set up" error.
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <div className="space-y-1.5">
            <Label>Session cap (min)</Label>
            <NumberInput
              value={String(val("voiceSessionCapMinutes", 10))}
              onChange={(raw: string) => set("voiceSessionCapMinutes", raw === "" ? 10 : Number(raw))}
              allowDecimal={false}
              data-testid="input-voice-session-cap"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Daily cap / parent (min)</Label>
            <NumberInput
              value={String(val("voiceDailyCapMinutes", 30))}
              onChange={(raw: string) => set("voiceDailyCapMinutes", raw === "" ? 30 : Number(raw))}
              allowDecimal={false}
              data-testid="input-voice-daily-cap"
            />
          </div>
        </div>

        <div className="flex items-center justify-between p-3 rounded-[var(--radius)] border">
          <div className="pr-4">
            <span className="text-sm font-medium">Video avatar (HeyGen LiveAvatar)</span>
            <p className="t-helper">The persona speaks as a realtime lip-synced talking head. Roughly doubles per-minute cost. Each persona's voice and talking head are chosen on the persona itself, in the Personas section below.</p>
          </div>
          <Switch
            checked={val("voiceAvatarEnabled", false)}
            onCheckedChange={(checked) => set("voiceAvatarEnabled", checked)}
            data-testid="switch-voice-avatar"
          />
        </div>

        {hasChanges && (
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setDraft({})} data-testid="btn-voice-settings-cancel">
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} data-testid="btn-save-voice-settings">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Save Voice Settings
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function RuleForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: { id?: string; condition: string; guidance: string; isActive: boolean; sortOrder: number };
  onSave: (data: any) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [condition, setCondition] = useState(initial?.condition || "");
  const [guidance, setGuidance] = useState(initial?.guidance || "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);

  return (
    <Card className="p-4 space-y-3 border-primary/30">
      <div>
        <Label className="t-form-label-sm font-semibold">IF the user mentions...</Label>
        <Input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          placeholder='"insurance coverage" or "success rates"'
          className="mt-1"
          data-testid="input-rule-condition"
        />
      </div>
      <div>
        <Label className="t-form-label-sm font-semibold">THEN guide with...</Label>
        <textarea
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="Mention that GoStork partners offer financing options through Prosper..."
          className="mt-1 w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y"
          data-testid="input-rule-guidance"
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-rule-active" />
          <span className="t-helper">Active</span>
        </div>
        <div className="flex items-center gap-2">
          <Label className="t-form-label-sm">Priority</Label>
          <NumberInput
            allowDecimal={false}
            value={String(sortOrder)}
            onChange={(v) => setSortOrder(parseInt(v) || 0)}
            className="w-16 h-8 text-xs"
            data-testid="input-rule-sort"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="button-rule-cancel">Cancel</Button>
        <Button
          size="sm"
          onClick={() => onSave({ condition, guidance, isActive, sortOrder })}
          disabled={!condition.trim() || !guidance.trim() || saving}
          data-testid="button-rule-save"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
          Save Rule
        </Button>
      </div>
    </Card>
  );
}

interface PromptSection {
  id: string;
  key: string;
  label: string;
  description: string | null;
  content: string;
  isActive: boolean;
  sortOrder: number;
  /**
   * Where this section actually takes effect:
   *  prompt         - assembled into Eva's system prompt
   *  live_elsewhere - read by other code (handoff copy, feature flag, tool block)
   *  inert          - nothing reads it; edits change nothing
   *  unregistered   - seeded but registered nowhere, so almost certainly inert
   */
  status?: "prompt" | "live_elsewhere" | "inert" | "unregistered";
  inPrompt?: boolean;
  /** Where a non-prompt section is actually consumed, or why it is inert. */
  usageNote?: string | null;
}

const SECTION_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  live_elsewhere: { label: "Used outside Eva's prompt", className: "bg-secondary" },
  inert: { label: "Not used", className: "bg-[hsl(var(--brand-warning))] text-white" },
  unregistered: { label: "Unregistered", className: "bg-[hsl(var(--brand-warning))] text-white" },
};

function PromptEditorCard() {
  const { toast } = useToast();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const sectionsQuery = useQuery<PromptSection[]>({
    queryKey: ["/api/admin/concierge-prompts"],
    queryFn: async () => {
      const res = await fetch("/api/admin/concierge-prompts", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  // Auto-seed on first load if empty
  useQuery({
    queryKey: ["/api/admin/concierge-prompts/seed"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/admin/concierge-prompts/seed");
      const data = await res.json();
      if (data.count > 0) queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-prompts"] });
      return data;
    },
    enabled: sectionsQuery.isSuccess && (sectionsQuery.data?.length || 0) === 0,
  });

  const sections = sectionsQuery.data || [];

  const handleSave = async (section: PromptSection) => {
    setSaving(section.id);
    try {
      await apiRequest("PUT", `/api/admin/concierge-prompts/${section.id}`, {
        content: editContent[section.key] ?? section.content,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-prompts"] });
      toast({ title: `"${section.label}" saved` });
      setEditContent(prev => { const n = { ...prev }; delete n[section.key]; return n; });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const handleToggle = async (section: PromptSection) => {
    try {
      await apiRequest("PUT", `/api/admin/concierge-prompts/${section.id}`, { isActive: !section.isActive });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-prompts"] });
      toast({ title: section.isActive ? "Section disabled" : "Section enabled" });
    } catch {
      toast({ title: "Failed", variant: "destructive" });
    }
  };

  return (
    <Card className="rounded-[var(--radius)] p-6" data-testid="card-prompt-editor">
      <div className="flex items-center gap-2.5 mb-4">
        <FileText className="w-5 h-5 text-primary" />
        <div>
          <h3 className="font-display text-base font-semibold">AI Prompt Instructions</h3>
          <p className="t-helper">Edit the system prompt sections that control AI concierge behavior. Changes take effect within 2 minutes.</p>
        </div>
      </div>

      {sectionsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : sections.length === 0 ? (
        <p className="t-helper py-4">Loading prompt sections...</p>
      ) : (
        <div className="space-y-2">
          {sections.map(section => {
            const isExpanded = expandedKey === section.key;
            const currentContent = editContent[section.key] ?? section.content;
            const hasChanges = editContent[section.key] !== undefined && editContent[section.key] !== section.content;

            return (
              <div key={section.id} className={`rounded-[var(--radius)] border ${!section.isActive ? "opacity-50" : ""}`}>
                <button
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedKey(isExpanded ? null : section.key)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-foreground">{section.label}</span>
                      {section.description && (
                        <p className="t-helper truncate">{section.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {section.status && SECTION_STATUS_BADGE[section.status] && (
                      <span className={`t-helper rounded-full px-2 py-0.5 whitespace-nowrap ${SECTION_STATUS_BADGE[section.status].className}`}>
                        {SECTION_STATUS_BADGE[section.status].label}
                      </span>
                    )}
                    {!section.isActive && <span className="t-helper">Disabled</span>}
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3">
                    {section.status && section.status !== "prompt" && (
                      <div className="rounded-[var(--radius)] bg-secondary p-3">
                        <p className="t-helper">
                          <span className="font-semibold">
                            {section.status === "live_elsewhere"
                              ? "This section is not part of Eva's system prompt."
                              : "Editing this section has no effect."}
                          </span>{" "}
                          {section.usageNote
                            ? section.usageNote
                            : "It is saved to the database but no code reads it, so changes here will not affect Eva or anything else. Register it in EVA_PROMPT_SECTION_KEYS or NON_PROMPT_SECTION_USAGE (server/ai-prompt-defaults.ts)."}
                        </p>
                      </div>
                    )}
                    <Textarea
                      value={currentContent}
                      onChange={(e) => setEditContent(prev => ({ ...prev, [section.key]: e.target.value }))}
                      className="min-h-[300px] font-mono text-xs leading-relaxed"
                      placeholder="Enter prompt instructions..."
                    />
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={section.isActive}
                          onCheckedChange={() => handleToggle(section)}
                        />
                        <span className="t-helper">
                          {section.isActive ? "Active" : "Disabled"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {hasChanges && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditContent(prev => { const n = { ...prev }; delete n[section.key]; return n; })}
                          >
                            Discard
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={!hasChanges || saving === section.id}
                          onClick={() => handleSave(section)}
                        >
                          {saving === section.id ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
                          Save
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function IntelligenceRulesCard() {
  const { toast } = useToast();
  const [showNewRule, setShowNewRule] = useState(false);
  const [editingRule, setEditingRule] = useState<string | null>(null);

  const rulesQuery = useQuery<any[]>({ queryKey: ["/api/knowledge/rules"] });

  const createRuleMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/knowledge/rules", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule Created" });
      setShowNewRule(false);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/rules"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const updateRuleMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest("PUT", `/api/knowledge/rules/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule Updated" });
      setEditingRule(null);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/rules"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/knowledge/rules/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule Deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/rules"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const rules = rulesQuery.data || [];

  return (
    <Card className="rounded-[var(--radius)] p-6" data-testid="card-intelligence-rules">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-display text-base font-semibold">Intelligence & Rules</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setShowNewRule(true); setEditingRule(null); }}
          data-testid="button-add-rule"
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Rule
        </Button>
      </div>
      <p className="t-helper mb-4">
        If/Then rules injected into the AI's system prompt. When a user mentions the condition, the AI follows the guidance.
      </p>

      {showNewRule && (
        <div className="mb-4">
          <RuleForm
            onSave={(data) => createRuleMutation.mutate(data)}
            onCancel={() => setShowNewRule(false)}
            saving={createRuleMutation.isPending}
          />
        </div>
      )}

      {rulesQuery.isLoading ? (
        <div className="t-helper flex items-center gap-2 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading rules...
        </div>
      ) : rules.length === 0 && !showNewRule ? (
        <div className="p-6 text-center border rounded-[var(--radius)]">
          <p className="t-helper">No expert guidance rules yet. Add rules to steer the AI concierge's responses.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule: any) => (
            <div key={rule.id}>
              {editingRule === rule.id ? (
                <RuleForm
                  initial={rule}
                  onSave={(data) => updateRuleMutation.mutate({ id: rule.id, data })}
                  onCancel={() => setEditingRule(null)}
                  saving={updateRuleMutation.isPending}
                />
              ) : (
                <Card className={`p-3 ${!rule.isActive ? "opacity-50" : ""}`} data-testid={`card-rule-${rule.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-semibold text-primary">IF</span>{" "}
                        <span className="text-foreground">"{rule.condition}"</span>
                      </p>
                      <p className="text-sm mt-1">
                        <span className="font-semibold text-primary">THEN</span>{" "}
                        <span className="text-muted-foreground">{rule.guidance}</span>
                      </p>
                      <div className="t-helper flex items-center gap-3 mt-2">
                        <span>Priority: {rule.sortOrder}</span>
                        <span>{rule.isActive ? "Active" : "Inactive"}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => { setEditingRule(rule.id); setShowNewRule(false); }} data-testid={`button-edit-rule-${rule.id}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => deleteRuleMutation.mutate(rule.id)}
                        disabled={deleteRuleMutation.isPending}
                        data-testid={`button-delete-rule-${rule.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function KnowledgeBaseCard() {
  const { toast } = useToast();
  const [bulkSyncRunning, setBulkSyncRunning] = useState(false);
  const [bulkSyncResult, setBulkSyncResult] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  const [answerInputs, setAnswerInputs] = useState<Record<string, string>>({});

  const documentsQuery = useQuery<any[]>({
    queryKey: ["/api/knowledge/documents"],
  });

  const whispersQuery = useQuery<any[]>({
    queryKey: ["/api/knowledge/whispers"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/knowledge/upload", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Document Uploaded", description: `${data.fileName} processed into ${data.chunks} knowledge chunks.` });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/documents"] });
    },
    onError: (err: any) => {
      toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (fileName: string) => {
      const res = await apiRequest("DELETE", `/api/knowledge/documents/${encodeURIComponent(fileName)}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document Removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/documents"] });
    },
    onError: (err: any) => {
      toast({ title: "Delete Failed", description: err.message, variant: "destructive" });
    },
  });

  const answerMutation = useMutation({
    mutationFn: async ({ id, answer }: { id: string; answer: string }) => {
      const res = await apiRequest("POST", `/api/knowledge/whispers/${id}/answer`, { answer });
      return res.json();
    },
    onSuccess: (_data: any, variables: { id: string }) => {
      toast({ title: "Answer Sent", description: "Your answer has been sent to the AI and the parent has been notified." });
      setAnswerInputs((prev) => {
        const next = { ...prev };
        delete next[variables.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/whispers"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleBulkSync = async () => {
    setBulkSyncRunning(true);
    setBulkSyncResult(null);
    try {
      const res = await apiRequest("POST", "/api/knowledge/bulk-sync");
      const data = await res.json();
      setBulkSyncResult(data);
      toast({ title: "Bulk Sync Complete", description: `${data.synced} synced, ${data.failed} failed` });
    } catch (err: any) {
      toast({ title: "Bulk Sync Failed", description: err.message, variant: "destructive" });
    } finally {
      setBulkSyncRunning(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      uploadMutation.mutate(files[0]);
    }
  }, [uploadMutation]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadMutation.mutate(files[0]);
    }
    e.target.value = "";
  }, [uploadMutation]);

  const docs = documentsQuery.data || [];
  const whispers = whispersQuery.data || [];
  const pendingWhispers = whispers.filter((w: any) => w.status === "PENDING");
  const answeredWhispers = whispers.filter((w: any) => w.status === "ANSWERED");

  return (
    <Card className="rounded-[var(--radius)] p-6" data-testid="card-knowledge-base">
      <div className="flex items-center gap-2.5 mb-1">
        <Brain className="w-5 h-5 text-primary" />
        <h3 className="font-display text-base font-semibold">Knowledge Base</h3>
      </div>
      <p className="t-helper mb-5">
        Upload documents and sync provider websites so the AI concierge can answer questions accurately.
      </p>

      <div className="space-y-4">
        <div className="rounded-[var(--radius)] border p-4" data-testid="section-unanswered-questions">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <MessageCircleQuestion className="w-4 h-4 text-[hsl(var(--brand-warning))]" />
            Unanswered AI Questions
            {pendingWhispers.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]">
                {pendingWhispers.length}
              </span>
            )}
          </h4>
          <p className="t-helper mb-3">
            When the AI concierge can't answer a parent's question, it appears here. Your response will be sent to the parent and taught to the AI.
          </p>
          {pendingWhispers.length === 0 ? (
            <p className="t-helper">No unanswered questions right now.</p>
          ) : (
            <div className="space-y-3">
              {pendingWhispers.map((w: any) => (
                <div key={w.id} className="p-3 rounded-[var(--radius)] border border-[hsl(var(--brand-warning))]/30 bg-[hsl(var(--brand-warning))]/5" data-testid={`card-whisper-${w.id}`}>
                  <p className="text-sm font-medium mb-1">"{w.questionText}"</p>
                  <p className="t-helper mb-2">
                    {new Date(w.createdAt).toLocaleDateString()} · Anonymous prospective parent
                  </p>
                  <textarea
                    value={answerInputs[w.id] || ""}
                    onChange={(e) => setAnswerInputs((prev) => ({ ...prev, [w.id]: e.target.value }))}
                    placeholder="Type your answer..."
                    className="w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-y"
                    data-testid={`input-whisper-answer-${w.id}`}
                  />
                  <div className="flex justify-end mt-2">
                    <Button
                      size="sm"
                      onClick={() => answerMutation.mutate({ id: w.id, answer: answerInputs[w.id] || "" })}
                      disabled={!answerInputs[w.id]?.trim() || answerMutation.isPending}
                      data-testid={`button-send-whisper-${w.id}`}
                    >
                      {answerMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
                      Send to AI
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-[var(--radius)] border p-4" data-testid="section-answered-questions">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-[hsl(var(--brand-success))]" />
            Answered Questions
          </h4>
          {answeredWhispers.length === 0 ? (
            <p className="t-helper mt-2">No answered questions yet. Answers you provide above will appear here.</p>
          ) : (
            <div className="space-y-2 mt-3">
              {answeredWhispers.slice(0, 5).map((w: any) => (
                <div key={w.id} className="p-3 rounded-[var(--radius)] border opacity-70" data-testid={`card-answered-${w.id}`}>
                  <p className="text-xs font-medium">Q: {w.questionText}</p>
                  <p className="t-helper mt-1">A: {w.answerText}</p>
                  <p className="t-helper mt-1">
                    Answered {new Date(w.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-[var(--radius)] border p-4" data-testid="section-documents">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Documents
          </h4>
          <div
            className={`p-6 border-2 border-dashed rounded-[var(--radius)] transition-colors cursor-pointer ${
              dragOver ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/40"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById("admin-knowledge-file-input")?.click()}
            data-testid="dropzone-document-upload"
          >
            <div className="flex flex-col items-center gap-2 text-center">
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                  <p className="text-sm font-medium">Processing document...</p>
                  <p className="t-helper">Extracting text, generating embeddings</p>
                </>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop a file here or click to upload</p>
                  <p className="t-helper">Supported: PDF, CSV, TXT, DOCX (max 20MB)</p>
                </>
              )}
            </div>
            <input
              id="admin-knowledge-file-input"
              type="file"
              accept=".pdf,.csv,.txt,.docx"
              className="hidden"
              onChange={handleFileSelect}
              data-testid="input-file-upload"
            />
          </div>

          <div className="mt-4">
            {documentsQuery.isLoading ? (
              <div className="t-helper flex items-center gap-2 py-3">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </div>
            ) : docs.length === 0 ? (
              <p className="t-helper">No documents uploaded yet. Upload files above to teach the AI about your practice.</p>
            ) : (
              <div className="space-y-2">
                {docs.map((doc: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-[var(--radius)] border" data-testid={`card-document-${i}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      {doc.sourceType === "WEBSITE" ? (
                        <Globe className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />
                      ) : (
                        <FileText className="w-4 h-4 text-primary shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {doc.sourceFileName || doc.sourceUrl || "Website Content"}
                        </p>
                        <p className="t-helper">
                          {doc.chunk_count} chunks · {doc.sourceType}
                          {doc.createdAt ? ` · ${new Date(doc.createdAt).toLocaleDateString()}` : ""}
                        </p>
                      </div>
                    </div>
                    {doc.sourceFileName && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(doc.sourceFileName); }}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-doc-${i}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[var(--radius)] border p-4" data-testid="section-bulk-sync">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Bulk Provider Website Sync</p>
              <p className="t-helper mt-0.5">
                Crawl all provider websites and update the AI knowledge base. Rate-limited to 1 request/second.
              </p>
            </div>
            <Button
              onClick={handleBulkSync}
              disabled={bulkSyncRunning}
              data-testid="button-bulk-sync"
            >
              {bulkSyncRunning ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Syncing...</>
              ) : (
                <><Globe className="w-4 h-4 mr-2" /> Sync All Providers</>
              )}
            </Button>
          </div>

          {bulkSyncResult && (
            <div className="mt-4 p-3 rounded-[var(--radius)] bg-muted/50 text-sm space-y-1" data-testid="text-bulk-sync-result">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-[hsl(var(--brand-success))]" />
                <span>{bulkSyncResult.synced} providers synced successfully</span>
              </div>
              {bulkSyncResult.failed > 0 && (
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-destructive" />
                  <span>{bulkSyncResult.failed} failed</span>
                </div>
              )}
              {bulkSyncResult.errors?.length > 0 && (
                <div className="t-helper mt-2 space-y-0.5">
                  {bulkSyncResult.errors.map((e: string, i: number) => (
                    <p key={i}>• {e}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function AdminConciergePage() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: brandSettings } = useBrandSettings();
  const activeTtsProvider = (brandSettings as any)?.voiceTtsProvider || "elevenlabs";
  // Catalogs for resolving voice/avatar ids to human names + photos in the
  // expanded persona preview (same query keys as the pickers - cache shared).
  const voiceCatalogQueries = {
    elevenlabs: useQuery<{ voices: VoiceOption[] }>({
      queryKey: ["/api/voice/options/voices", "elevenlabs"],
      queryFn: async () => (await apiRequest("GET", "/api/voice/options/voices?provider=elevenlabs")).json(),
      staleTime: 10 * 60 * 1000, retry: 1,
    }),
    openai: useQuery<{ voices: VoiceOption[] }>({
      queryKey: ["/api/voice/options/voices", "openai"],
      queryFn: async () => (await apiRequest("GET", "/api/voice/options/voices?provider=openai")).json(),
      staleTime: 10 * 60 * 1000, retry: 1,
    }),
    cartesia: useQuery<{ voices: VoiceOption[] }>({
      queryKey: ["/api/voice/options/voices", "cartesia"],
      queryFn: async () => (await apiRequest("GET", "/api/voice/options/voices?provider=cartesia")).json(),
      staleTime: 10 * 60 * 1000, retry: 1,
    }),
  } as const;
  const avatarCatalogQuery = useQuery<{ avatars: AvatarOption[] }>({
    queryKey: ["/api/voice/options/avatars"],
    queryFn: async () => (await apiRequest("GET", "/api/voice/options/avatars")).json(),
    staleTime: 10 * 60 * 1000, retry: 1,
  });
  const resolveVoiceName = (provider: string, id: string | null | undefined): string | null => {
    if (!id) return null;
    const list = (voiceCatalogQueries as any)[provider]?.data?.voices as VoiceOption[] | undefined;
    return list?.find((v) => v.id === id)?.name || id;
  };
  const resolveAvatar = (id: string | null | undefined): AvatarOption | null => {
    if (!id) return null;
    return avatarCatalogQuery.data?.avatars.find((a) => a.id === id) || { id, name: id, kind: "preset" };
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [personaPreviewing, setPersonaPreviewing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Matchmaker>>({});
  const [avatarCropSrc, setAvatarCropSrc] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const matchmakersQuery = useQuery<Matchmaker[]>({
    queryKey: ["/api/brand/matchmakers"],
    queryFn: async () => {
      const res = await fetch("/api/brand/matchmakers", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Matchmaker>) => {
      const res = await apiRequest("POST", "/api/brand/matchmakers", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setShowAddForm(false);
      setEditForm({});
      toast({ title: "Matchmaker created", variant: "success" });
    },
    onError: () => toast({ title: "Failed to create matchmaker", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: Partial<Matchmaker> & { id: string }) => {
      const res = await apiRequest("PUT", `/api/brand/matchmakers/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setEditingId(null);
      setEditForm({});
      toast({ title: "Matchmaker updated", variant: "success" });
    },
    onError: () => toast({ title: "Failed to update matchmaker", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/brand/matchmakers/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      toast({ title: "Matchmaker deleted", variant: "success" });
    },
    onError: () => toast({ title: "Failed to delete matchmaker", variant: "destructive" }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiRequest("PUT", `/api/brand/matchmakers/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const handleAvatarUpload = async (file: File | Blob, callback: (url: string) => void) => {
    setAvatarCropSrc(null);
    const formData = new FormData();
    formData.append("file", file, file instanceof File ? file.name : "avatar.jpg");
    try {
      const res = await fetch("/api/uploads/persona-avatar", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      callback(data.url);
    } catch {
      toast({ title: "Failed to upload image", variant: "destructive" });
    }
  };

  const matchmakers = matchmakersQuery.data || [];
  const activeCount = matchmakers.filter(m => m.isActive).length;

  const renderForm = (isNew: boolean) => {
    const onSave = () => {
      if (!editForm.name || !editForm.title || !editForm.description || !editForm.personalityPrompt) {
        toast({ title: "Name, title, description, and personality prompt are required", variant: "destructive" });
        return;
      }
      if (isNew) {
        createMutation.mutate({ ...editForm, isActive: editForm.isActive !== false });
      } else if (editingId) {
        updateMutation.mutate({ id: editingId, ...editForm });
      }
    };

    return (
      <Card className="rounded-[var(--radius)] p-5 space-y-4 border-primary/20 border-2" data-testid={isNew ? "matchmaker-add-form" : `matchmaker-edit-form-${editingId}`}>
        <div className="flex items-center gap-2 pb-2 border-b">
          <Bot className="w-4 h-4 text-primary" />
          <span className="font-medium text-sm">{isNew ? "New Matchmaker" : "Edit Matchmaker"}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label >Name *</Label>
            <Input placeholder="e.g. Ariel" value={editForm.name || ""} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} data-testid="input-matchmaker-name" />
          </div>
          <div className="space-y-1.5">
            <Label >Title *</Label>
            <Input placeholder="e.g. The Warm Guide" value={editForm.title || ""} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} data-testid="input-matchmaker-title" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label >Description *</Label>
          <Textarea placeholder="Brief description of this matchmaker's personality..." value={editForm.description || ""} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={2} data-testid="input-matchmaker-description" />
        </div>

        <div className="space-y-1.5">
          <Label >Personality Prompt *</Label>
          <Textarea placeholder="System prompt that defines the AI's personality and behavior..." value={editForm.personalityPrompt || ""} onChange={(e) => setEditForm({ ...editForm, personalityPrompt: e.target.value })} rows={4} className="font-mono text-xs" data-testid="input-matchmaker-prompt" />
          <p className="t-helper">This prompt shapes how the AI persona communicates. It is never visible to parents.</p>
        </div>

        <div className="space-y-1.5">
          <Label >Initial Greeting</Label>
          <Textarea placeholder="The first message parents see when they select this matchmaker..." value={editForm.initialGreeting || ""} onChange={(e) => setEditForm({ ...editForm, initialGreeting: e.target.value })} rows={2} data-testid="input-matchmaker-greeting" />
          <p className="t-helper">Optional. Displayed as the opening message when a parent selects this persona.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label >Voice - {TTS_PROVIDER_LABELS[activeTtsProvider]?.split(" ")[0] || activeTtsProvider}</Label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <VoicePicker
                  provider={activeTtsProvider}
                  value={(editForm.voiceIds || {})[activeTtsProvider] ?? (activeTtsProvider === "elevenlabs" ? editForm.voiceId || "" : "")}
                  onChange={(id) => setEditForm({ ...editForm, voiceIds: { ...(editForm.voiceIds || {}), [activeTtsProvider]: id } })}
                  testId="input-matchmaker-voice-id"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={personaPreviewing}
                onClick={async () => {
                  setPersonaPreviewing(true);
                  try {
                    await playVoicePreview(
                      activeTtsProvider,
                      (editForm.voiceIds || {})[activeTtsProvider] ?? (activeTtsProvider === "elevenlabs" ? editForm.voiceId || "" : ""),
                    );
                  } catch (err: any) {
                    toast({ title: "Voice preview failed", description: err?.message, variant: "destructive" });
                  } finally {
                    setPersonaPreviewing(false);
                  }
                }}
                data-testid="btn-matchmaker-voice-preview"
              >
                {personaPreviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Volume2 className="w-3.5 h-3.5 mr-1.5" />}
                Preview
              </Button>
            </div>
            <p className="t-helper">How this persona sounds in voice mode, for the active provider - each provider keeps its own choice. Tap Preview to hear it.</p>
          </div>
          <div className="space-y-1.5">
            <Label >Video avatar</Label>
            <AvatarPicker
              value={editForm.avatarFaceId || ""}
              onChange={(id) => setEditForm({ ...editForm, avatarFaceId: id })}
              testId="input-matchmaker-avatar-face-id"
            />
            <p className="t-helper">The talking head this persona uses when the video avatar is on. Create a photo avatar from this persona's photo in the LiveAvatar dashboard and it appears here with a "Custom" badge.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label >Avatar</Label>
            <div className="flex items-center gap-3">
              {editForm.avatarUrl && (
                <img src={getPhotoSrc(editForm.avatarUrl) || undefined} alt={editForm.name || "Avatar"} className="w-10 h-10 rounded-full object-cover border" data-testid="img-matchmaker-avatar-preview" />
              )}
              <label className="cursor-pointer">
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) { const reader = new FileReader(); reader.onload = () => setAvatarCropSrc(reader.result as string); reader.readAsDataURL(file); } e.target.value = ""; }} data-testid="input-matchmaker-avatar-upload" />
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-[var(--radius)] hover:bg-muted transition-colors">
                  <Upload className="w-3.5 h-3.5" />
                  {editForm.avatarUrl ? "Change" : "Upload"}
                </span>
              </label>
              {editForm.avatarUrl && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setEditForm({ ...editForm, avatarUrl: null })} data-testid="btn-clear-matchmaker-avatar">
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
              {avatarCropSrc && (
                <ImageCropPreview
                  imageSrc={avatarCropSrc}
                  onCropComplete={(blob) => handleAvatarUpload(blob, (url) => setEditForm({ ...editForm, avatarUrl: url }))}
                  onCancel={() => setAvatarCropSrc(null)}
                  aspect={1}
                  cropShape="round"
                />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label >Status</Label>
            <div className="flex items-center gap-2 pt-1">
              <Switch checked={editForm.isActive !== false} onCheckedChange={(checked) => setEditForm({ ...editForm, isActive: checked })} data-testid="switch-matchmaker-active" />
              <span className="t-helper">{editForm.isActive !== false ? "Active - visible to parents" : "Inactive - hidden from parents"}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button variant="outline" size="sm" onClick={() => { setEditingId(null); setShowAddForm(false); setEditForm({}); }} data-testid="btn-matchmaker-cancel">Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={createMutation.isPending || updateMutation.isPending} data-testid="btn-matchmaker-save">
            {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
            {isNew ? "Create Matchmaker" : "Save Changes"}
          </Button>
        </div>
      </Card>
    );
  };

  return (
    <div className="space-y-6" data-testid="admin-concierge-page">
      <SystemSettingsCard />

      <VoiceSettingsCard />

      <Card className="rounded-[var(--radius)] p-6" data-testid="card-personas">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Bot className="w-5 h-5 text-primary" />
            <h3 className="font-display text-base font-semibold">Personas</h3>
          </div>
          {!showAddForm && !editingId && (
            <Button size="sm" onClick={() => { setShowAddForm(true); setEditForm({ isActive: true }); }} data-testid="btn-add-matchmaker">
              <Plus className="w-4 h-4 mr-1.5" /> Add Persona
            </Button>
          )}
        </div>

        {matchmakers.length > 0 && (
          <div className="t-helper flex items-center gap-4 mb-4" data-testid="matchmaker-stats">
            <span>{matchmakers.length} persona{matchmakers.length !== 1 ? "s" : ""} total</span>
            <span className="text-[hsl(var(--brand-success))]">{activeCount} active</span>
            {matchmakers.length - activeCount > 0 && (
              <span className="text-[hsl(var(--brand-warning))]">{matchmakers.length - activeCount} inactive</span>
            )}
          </div>
        )}

        {matchmakersQuery.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" data-testid="matchmakers-loading" />
          </div>
        )}

        {showAddForm && <div className="mb-4">{renderForm(true)}</div>}

        <div className="space-y-3">
          {matchmakers.map((m) => (
            editingId === m.id ? (
              <div key={m.id}>{renderForm(false)}</div>
            ) : (
              <Card key={m.id} className={`rounded-[var(--radius)] overflow-hidden transition-all ${!m.isActive ? "opacity-60" : ""}`} data-testid={`matchmaker-card-${m.id}`}>
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer hover:bg-secondary/40 transition-colors"
                  onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
                  data-testid={`matchmaker-header-${m.id}`}
                >
                  <div className="flex-shrink-0 text-muted-foreground/40"><GripVertical className="w-4 h-4" /></div>
                  <div className="flex-shrink-0">
                    {m.avatarUrl ? (
                      <img src={getPhotoSrc(m.avatarUrl) || undefined} alt={m.name} className="w-11 h-11 rounded-full object-cover border" />
                    ) : (
                      <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-sm">{m.name.charAt(0)}</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{m.name}</span>
                      <span className="t-helper px-1.5 py-0.5 bg-muted rounded">{m.title}</span>
                      {!m.isActive && (
                        <span className="text-xs text-[hsl(var(--brand-warning))] px-1.5 py-0.5 bg-[hsl(var(--brand-warning))]/10 rounded" data-testid={`badge-inactive-${m.id}`}>Inactive</span>
                      )}
                    </div>
                    <p className="t-helper line-clamp-1 mt-0.5">{m.description}</p>
                    {/* LIVE link to the global Voice settings: what this persona
                        speaks with RIGHT NOW - updates the moment the active
                        provider above changes. */}
                    {(brandSettings as any)?.voiceModeEnabled && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5" data-testid={`persona-live-voice-${m.id}`}>
                        {(() => {
                          const vid = (m.voiceIds || {})[activeTtsProvider] ?? (activeTtsProvider === "elevenlabs" ? m.voiceId : null);
                          const vName = vid ? resolveVoiceName(activeTtsProvider, vid) : null;
                          const provLabel = TTS_PROVIDER_LABELS[activeTtsProvider]?.split(" ")[0] || activeTtsProvider;
                          return vName ? (
                            <span className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                              <Volume2 className="w-3 h-3" /> Speaks with {vName?.split(" - ")[0]} ({provLabel})
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))]">
                              <Volume2 className="w-3 h-3" /> No {provLabel} voice - using fallback
                            </span>
                          );
                        })()}
                        {(brandSettings as any)?.voiceAvatarEnabled && (() => {
                          const av = resolveAvatar(m.avatarFaceId);
                          return av ? (
                            <span className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                              <Video className="w-3 h-3" /> {av.name}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))]">
                              <Video className="w-3 h-3" /> No avatar - voice only
                            </span>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Switch checked={m.isActive} onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: m.id, isActive: checked })} data-testid={`switch-active-${m.id}`} />
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setExpandedId(expandedId === m.id ? null : m.id)} data-testid={`btn-expand-matchmaker-${m.id}`}>
                      {expandedId === m.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => { setEditingId(m.id); setEditForm(m); setShowAddForm(false); setExpandedId(null); }} data-testid={`btn-edit-matchmaker-${m.id}`}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={async () => { const ok = await confirm({ title: "Delete matchmaker", message: `Delete matchmaker "${m.name}"? This cannot be undone.`, confirmLabel: "Delete", tone: "destructive" }); if (ok) deleteMutation.mutate(m.id); }} disabled={deleteMutation.isPending} data-testid={`btn-delete-matchmaker-${m.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {expandedId === m.id && (
                  <div className="px-4 pb-4 pt-0 border-t space-y-3" data-testid={`matchmaker-details-${m.id}`}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
                      <div className="space-y-1">
                        <div className="t-micro-label flex items-center gap-1.5">
                          <Bot className="w-3.5 h-3.5" /> Personality Prompt
                        </div>
                        <p className="text-sm bg-muted/50 rounded-[var(--radius)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{m.personalityPrompt}</p>
                      </div>
                      <div className="space-y-1">
                        <div className="t-micro-label flex items-center gap-1.5">
                          <MessageSquare className="w-3.5 h-3.5" /> Initial Greeting
                        </div>
                        {m.initialGreeting ? (
                          <p className="text-sm bg-muted/50 rounded-[var(--radius)] p-3 leading-relaxed">{m.initialGreeting}</p>
                        ) : (
                          <p className="t-helper italic p-3">No custom greeting set</p>
                        )}
                      </div>
                    </div>
                    {/* Voice + video avatar - every field the edit form has */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <div className="t-micro-label flex items-center gap-1.5">
                          <Volume2 className="w-3.5 h-3.5" /> Voices
                        </div>
                        <div className="bg-muted/50 rounded-[var(--radius)] p-3 space-y-1.5">
                          {(["elevenlabs", "openai", "cartesia"] as const).map((prov) => {
                            const vid = (m.voiceIds || {})[prov] ?? (prov === "elevenlabs" ? m.voiceId : null);
                            const name = resolveVoiceName(prov, vid);
                            return (
                              <div key={prov} className="flex items-center gap-2 text-sm">
                                <span className={`t-helper w-24 shrink-0 ${prov === activeTtsProvider ? "font-semibold text-foreground" : ""}`}>
                                  {TTS_PROVIDER_LABELS[prov]?.split(" ")[0]}
                                  {prov === activeTtsProvider ? " *" : ""}
                                </span>
                                {name ? <span>{name}</span> : <span className="t-helper italic">Not set - uses built-in fallback</span>}
                              </div>
                            );
                          })}
                          <p className="t-helper pt-1">* active provider</p>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="t-micro-label flex items-center gap-1.5">
                          <Video className="w-3.5 h-3.5" /> Video Avatar
                        </div>
                        <div className="bg-muted/50 rounded-[var(--radius)] p-3">
                          {(() => {
                            const av = resolveAvatar(m.avatarFaceId);
                            if (!av) return <p className="t-helper italic">Not set - voice only, no talking head</p>;
                            return (
                              <div className="flex items-center gap-2.5 text-sm">
                                {av.imageUrl ? (
                                  <img src={av.imageUrl} alt="" className="w-9 h-9 rounded-full object-cover border" />
                                ) : (
                                  <span className="w-9 h-9 rounded-full bg-secondary" />
                                )}
                                <span>{av.name}</span>
                                {av.kind === "custom" && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground font-ui">Custom</span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            )
          ))}
        </div>

        {!matchmakersQuery.isLoading && matchmakers.length === 0 && !showAddForm && (
          <div className="rounded-[var(--radius)] p-12 text-center border" data-testid="matchmakers-empty">
            <Sparkles className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="t-helper">No matchmaker personas configured yet.</p>
            <Button size="sm" className="mt-4" onClick={() => { setShowAddForm(true); setEditForm({ isActive: true }); }} data-testid="btn-add-first-matchmaker">
              <Plus className="w-4 h-4 mr-1.5" /> Create Your First Persona
            </Button>
          </div>
        )}
      </Card>

      <PromptEditorCard />

      <IntelligenceRulesCard />

      <KnowledgeBaseCard />

      <ParentPrepGuidesCard />
    </div>
  );
}

// Phase 4: admin-managed documents Eva sends to parents at journey moments.
// One slot per call type: the Match Call prep guide (surrogacy) and the
// Doctor Call prep guide (IVF). Upload replaces the file for that slot.
const PREP_GUIDE_SLOTS = [
  {
    key: "match_call_prep_guide",
    label: "Match Call prep guide (PDF)",
    description: "Attached in the parent's chat as soon as their match call is confirmed, together with the 24-hour hold explanation.",
    successNote: "will now be sent to parents when a match call is scheduled.",
  },
  {
    key: "doctor_call_prep_guide",
    label: "Doctor Call prep guide (PDF)",
    description: "Attached in the parent's chat as soon as their doctor call with an IVF clinic is confirmed.",
    successNote: "will now be sent to parents when a doctor call is scheduled.",
  },
  {
    key: "consultation_prep_guide_ivf",
    label: "First consultation - IVF Clinic (PDF)",
    description: "Sent when a parent's FIRST consultation with an IVF clinic is confirmed.",
    successNote: "will now be sent before first IVF clinic consultations.",
  },
  {
    key: "consultation_prep_guide_surrogacy",
    label: "First consultation - Surrogacy Agency (PDF)",
    description: "Sent when a parent's FIRST consultation with a surrogacy agency is confirmed.",
    successNote: "will now be sent before first surrogacy agency consultations.",
  },
  {
    key: "consultation_prep_guide_egg_donor",
    label: "First consultation - Egg Donor Agency (PDF)",
    description: "Sent when a parent's FIRST consultation with an egg donor agency or egg bank is confirmed.",
    successNote: "will now be sent before first egg donor consultations.",
  },
  {
    key: "consultation_prep_guide_sperm_bank",
    label: "First consultation - Sperm Bank (PDF)",
    description: "Sent when a parent's FIRST consultation with a sperm bank is confirmed.",
    successNote: "will now be sent before first sperm bank consultations.",
  },
] as const;

function PrepGuideSlot({ slot }: { slot: (typeof PREP_GUIDE_SLOTS)[number] }) {
  const { toast } = useToast();
  const assetQuery = useQuery<{ asset: { key: string; fileName: string; updatedAt: string } | null }>({
    queryKey: [`/api/knowledge/concierge-assets/${slot.key}`],
  });
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/knowledge/concierge-assets/${slot.key}`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Prep guide updated", description: `${data.asset.fileName} ${slot.successNote}` });
      queryClient.invalidateQueries({ queryKey: [`/api/knowledge/concierge-assets/${slot.key}`] });
    },
    onError: (err: any) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const asset = assetQuery.data?.asset ?? null;
  return (
    <div className="rounded-lg border p-4 flex flex-wrap items-center justify-between gap-3 bg-secondary/30">
      <div className="min-w-0">
        <p className="font-medium text-sm">{slot.label}</p>
        <p className="t-helper mt-0.5">{slot.description}</p>
        {asset ? (
          <p className="text-xs mt-1.5">
            <a
              href={`/api/knowledge/concierge-assets/${slot.key}/file`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
              style={{ color: "hsl(var(--primary))" }}
            >
              {asset.fileName}
            </a>
            <span className="text-muted-foreground"> - updated {new Date(asset.updatedAt).toLocaleDateString()}</span>
          </p>
        ) : (
          <p className="text-xs mt-1.5" style={{ color: "hsl(var(--brand-warning))" }}>
            No guide uploaded yet - parents currently get the confirmation without an attachment.
          </p>
        )}
      </div>
      <label className="shrink-0">
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) uploadMutation.mutate(f);
          }}
          data-testid={`prep-guide-upload-input-${slot.key}`}
        />
        <span
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[var(--radius)] text-sm font-medium text-primary-foreground cursor-pointer transition-opacity hover:opacity-90"
          style={{ backgroundColor: "hsl(var(--primary))" }}
        >
          <Upload className="w-4 h-4" />
          {uploadMutation.isPending ? "Uploading..." : asset ? "Replace PDF" : "Upload PDF"}
        </span>
      </label>
    </div>
  );
}

function ParentPrepGuidesCard() {
  return (
    <Card className="p-6 space-y-4">
      <div>
        <h3 className="font-heading font-semibold text-lg">Parent Prep Guides</h3>
        <p className="t-helper mt-0.5">
          Documents Eva automatically sends to parents at key journey moments.
        </p>
      </div>
      {PREP_GUIDE_SLOTS.map(slot => (
        <PrepGuideSlot key={slot.key} slot={slot} />
      ))}
    </Card>
  );
}
