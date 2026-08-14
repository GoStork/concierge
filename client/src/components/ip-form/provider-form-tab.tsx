/**
 * Per-provider Parent Form tab - ONE shared component for both mount points:
 *   - Admin provider edit page (/admin/providers/:id?tab=parent-form), mode
 *     "admin": form-collection checkboxes + the GoStork-controlled "provider
 *     may edit" toggle + the adjustments editor.
 *   - Provider settings (/account/parent-form), mode "provider": the same
 *     adjustments editor, read-only unless GoStork enabled canEditParentForm.
 *
 * Adjustments are per-provider deltas on the GLOBAL template (edited at
 * /account/ip-form-template): hide a section or question, override a
 * question's label/help/required, or add provider-specific custom questions.
 * They shape what this provider's families are asked and what prints on this
 * provider's PDF - the global template itself is never modified here.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardList, Loader2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const WIDGETS = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "yes_no", label: "Yes / No" },
  { value: "dropdown", label: "Dropdown / choices" },
  { value: "date", label: "Date" },
  { value: "address", label: "Address" },
  { value: "phone", label: "Phone" },
  { value: "number", label: "Number" },
  { value: "file", label: "File upload (image / PDF)" },
];

interface ConfigQuestion {
  id: string;
  sectionId: string;
  key: string;
  label: string;
  helpText: string | null;
  widget: string;
  options: string[] | null;
  required: boolean;
  perParent: boolean;
  providerId?: string | null;
  sortOrder: number;
}

interface ConfigSection {
  id: string;
  key: string;
  title: string;
  description: string | null;
  perParent: boolean;
  appliesTo: string[];
  questions: ConfigQuestion[];
}

interface Override {
  id: string;
  targetType: string;
  targetId: string;
  hidden: boolean;
  label: string | null;
  helpText: string | null;
  required: boolean | null;
}

interface ProviderFormConfig {
  provider: {
    id: string;
    name: string;
    collectsIntendedParentForm: boolean;
    requiresIdPhotocopy: boolean;
    canEditParentForm: boolean;
  };
  programTypes: string[];
  sections: ConfigSection[];
  overrides: Override[];
  customQuestions: ConfigQuestion[];
  canEdit: boolean;
  isAdmin: boolean;
}

export default function ProviderParentFormTab({ providerId, mode }: { providerId: string; mode: "admin" | "provider" }) {
  const { toast } = useToast();
  const configKey = [`/api/ip-form/provider-config/${providerId}`];
  const { data, isLoading } = useQuery<ProviderFormConfig>({ queryKey: configKey });
  const refresh = () => queryClient.invalidateQueries({ queryKey: configKey });

  const [savingFlag, setSavingFlag] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { provider, sections, overrides, customQuestions, canEdit } = data;
  const overrideFor = (type: "section" | "question", id: string) =>
    overrides.find((o) => o.targetType === type && o.targetId === id);

  const saveProviderFlag = async (patch: Record<string, boolean>) => {
    const flag = Object.keys(patch)[0];
    setSavingFlag(flag);
    try {
      await apiRequest("PUT", `/api/providers/${providerId}`, patch);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["/api/providers", providerId] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message, variant: "destructive" });
    } finally {
      setSavingFlag(null);
    }
  };

  const saveOverride = async (type: "section" | "question", targetId: string, patch: Partial<Override>) => {
    const current = overrideFor(type, targetId);
    const merged = {
      targetType: type,
      targetId,
      hidden: patch.hidden ?? current?.hidden ?? false,
      label: patch.label !== undefined ? patch.label : current?.label ?? null,
      helpText: patch.helpText !== undefined ? patch.helpText : current?.helpText ?? null,
      required: patch.required !== undefined ? patch.required : current?.required ?? null,
    };
    try {
      await apiRequest("PUT", `/api/ip-form/provider-config/${providerId}/override`, merged);
      refresh();
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message, variant: "destructive" });
    }
  };

  const programLabel = data.programTypes.includes("surrogacy")
    ? "surrogacy"
    : data.programTypes.includes("ivf") ? "IVF clinic" : "provider";

  return (
    <div className="space-y-4" data-testid="provider-parent-form-tab">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-heading font-bold">Intended Parent Form</h2>
          <p className="t-helper">
            {mode === "admin"
              ? `How ${provider.name} collects the Intended Parent Form, and this provider's adjustments to the ${programLabel} template.`
              : "The Intended Parent Form your families complete. Adjustments here apply only to your organization's families and PDFs."}
          </p>
        </div>
      </div>

      {mode === "admin" && (
        <Card className="p-4 space-y-3">
          <p className="font-ui font-medium">Form collection</p>
          <label className="flex items-start gap-2 text-sm cursor-pointer rounded-[var(--radius)] bg-secondary p-3">
            <Checkbox
              className="mt-0.5"
              checked={provider.collectsIntendedParentForm}
              disabled={savingFlag === "collectsIntendedParentForm"}
              onCheckedChange={(v) => saveProviderFlag({ collectsIntendedParentForm: !!v })}
              data-testid="checkbox-edit-collects-ip-form"
            />
            <span>
              <span className="font-ui">Collects the Intended Parent Form</span> - after a consultation, parents are prompted to
              complete the form and this provider can download it. Surrogacy agencies get the full form; other providers (e.g.
              international IVF clinics) get the short version (basic info + ID).
            </span>
          </label>
          {provider.collectsIntendedParentForm && (
            <label className="flex items-start gap-2 text-sm cursor-pointer rounded-[var(--radius)] bg-secondary p-3">
              <Checkbox
                className="mt-0.5"
                checked={provider.requiresIdPhotocopy}
                disabled={savingFlag === "requiresIdPhotocopy"}
                onCheckedChange={(v) => saveProviderFlag({ requiresIdPhotocopy: !!v })}
                data-testid="checkbox-edit-requires-id-photocopy"
              />
              <span>
                <span className="font-ui">Requires a copy of each parent's ID document</span> - parents must upload a photo/scan of
                their passport or government ID. Requested automatically when this provider connects, even if the form was already
                submitted.
              </span>
            </label>
          )}
          <label className="flex items-start gap-2 text-sm cursor-pointer rounded-[var(--radius)] bg-accent/15 p-3">
            <Checkbox
              className="mt-0.5"
              checked={provider.canEditParentForm}
              disabled={savingFlag === "canEditParentForm"}
              onCheckedChange={(v) => saveProviderFlag({ canEditParentForm: !!v })}
              data-testid="checkbox-edit-can-edit-parent-form"
            />
            <span>
              <span className="font-ui">Allow this provider to edit its own Parent Form</span> - the provider gets the same
              adjustments editor (hide questions, reword, add custom questions) in its Settings &gt; Parent Form tab. Off = the
              provider sees a read-only view; only GoStork can adjust it here.
            </span>
          </label>
        </Card>
      )}

      {mode === "provider" && !provider.collectsIntendedParentForm && (
        <Card className="p-4 bg-secondary">
          <p className="text-sm">
            GoStork has not enabled Intended Parent Form collection for your organization yet. Contact GoStork to turn it on -
            below is a preview of the form your families would receive.
          </p>
        </Card>
      )}
      {mode === "provider" && !canEdit && (
        <Card className="p-4 bg-secondary">
          <p className="text-sm">
            This form is managed by GoStork. You can review every section and question below; contact GoStork to request changes
            or to enable self-service editing for your organization.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {sections.map((section) => (
          <SectionAdjuster
            key={section.id}
            providerId={providerId}
            section={section}
            override={overrideFor("section", section.id)}
            questionOverrideFor={(qid) => overrideFor("question", qid)}
            customQuestions={customQuestions.filter((q) => q.sectionId === section.id)}
            canEdit={canEdit}
            saveOverride={saveOverride}
            refresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function SectionAdjuster({
  providerId,
  section,
  override,
  questionOverrideFor,
  customQuestions,
  canEdit,
  saveOverride,
  refresh,
}: {
  providerId: string;
  section: ConfigSection;
  override: Override | undefined;
  questionOverrideFor: (questionId: string) => Override | undefined;
  customQuestions: ConfigQuestion[];
  canEdit: boolean;
  saveOverride: (type: "section" | "question", targetId: string, patch: Partial<Override>) => Promise<void>;
  refresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const hidden = !!override?.hidden;
  // Custom questions merged into their template position, like the live form.
  const allQuestions: ConfigQuestion[] = [...section.questions, ...customQuestions].sort((a, b) => a.sortOrder - b.sortOrder);
  const visibleCount = allQuestions.filter((q) => !questionOverrideFor(q.id)?.hidden).length;

  return (
    <Card className={`p-4 space-y-3 ${hidden ? "opacity-60" : ""}`} data-testid={`provider-form-section-${section.key}`}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="p-1 rounded hover:bg-secondary" aria-label="Expand section">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">
            {override?.label || section.title}
            <span className="t-helper ml-2">
              {visibleCount} questions
              {section.perParent ? " - per parent" : ""}
              {customQuestions.length ? ` - ${customQuestions.length} custom` : ""}
              {hidden ? " - HIDDEN for this provider" : ""}
            </span>
          </p>
        </div>
        {canEdit && (
          <label className="flex items-center gap-2 text-sm shrink-0">
            <Switch
              checked={!hidden}
              onCheckedChange={(v) => saveOverride("section", section.id, { hidden: !v })}
              data-testid={`provider-form-section-shown-${section.key}`}
            />
            Shown
          </label>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 pl-7">
          {section.description && <p className="t-helper">{section.description}</p>}
          {allQuestions.map((q) => (
            <QuestionAdjuster
              key={q.id}
              providerId={providerId}
              question={q}
              isCustom={!!q.providerId}
              override={questionOverrideFor(q.id)}
              canEdit={canEdit}
              saveOverride={saveOverride}
              refresh={refresh}
            />
          ))}
          {canEdit && !adding && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid={`provider-form-add-question-${section.key}`}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Add question for this provider
            </Button>
          )}
          {canEdit && adding && (
            <CustomQuestionForm
              providerId={providerId}
              sectionId={section.id}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
              onCancel={() => setAdding(false)}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function QuestionAdjuster({
  providerId,
  question,
  isCustom,
  override,
  canEdit,
  saveOverride,
  refresh,
}: {
  providerId: string;
  question: ConfigQuestion;
  isCustom: boolean;
  override: Override | undefined;
  canEdit: boolean;
  saveOverride: (type: "section" | "question", targetId: string, patch: Partial<Override>) => Promise<void>;
  refresh: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(override?.label || question.label);
  const [helpText, setHelpText] = useState(override?.helpText ?? question.helpText ?? "");
  const [optionsText, setOptionsText] = useState((question.options || []).join("\n"));
  const [saving, setSaving] = useState(false);
  const hidden = !!override?.hidden;
  const effectiveRequired = override?.required ?? question.required;

  const saveEdits = async () => {
    setSaving(true);
    try {
      if (isCustom) {
        await apiRequest("PUT", `/api/ip-form/provider-config/${providerId}/questions/${question.id}`, {
          label,
          helpText,
          options: optionsText.split("\n").map((o) => o.trim()).filter(Boolean),
        });
        refresh();
      } else {
        // Reverting the wording back to the template clears the override text.
        await saveOverride("question", question.id, {
          label: label.trim() && label.trim() !== question.label ? label.trim() : null,
          helpText: helpText.trim() && helpText.trim() !== (question.helpText || "") ? helpText.trim() : null,
        });
      }
      setEditing(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const removeCustom = async () => {
    try {
      await apiRequest("PUT", `/api/ip-form/provider-config/${providerId}/questions/${question.id}`, { isActive: false });
      refresh();
    } catch (e: any) {
      toast({ title: "Could not remove", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <div className={`rounded-[var(--radius)] border border-border ${hidden ? "opacity-60" : ""}`} data-testid={`provider-form-question-${question.key}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <p className="flex-1 min-w-0 text-sm truncate">
          {override?.label || question.label}
          <span className="t-helper ml-2">
            {WIDGETS.find((w) => w.value === question.widget)?.label || question.widget}
            {effectiveRequired ? " - required" : ""}
            {question.perParent ? " - per parent" : ""}
            {isCustom ? " - custom (this provider only)" : override && (override.label || override.helpText || override.required != null) ? " - adjusted" : ""}
            {hidden ? " - hidden" : ""}
          </span>
        </p>
        {canEdit && (
          <>
            <label className="flex items-center gap-1.5 text-xs shrink-0">
              <Switch
                checked={effectiveRequired}
                onCheckedChange={(v) =>
                  isCustom
                    ? apiRequest("PUT", `/api/ip-form/provider-config/${providerId}/questions/${question.id}`, { required: v }).then(refresh)
                    : saveOverride("question", question.id, { required: v === question.required ? null : v })
                }
              />
              Required
            </label>
            {!isCustom && (
              <label className="flex items-center gap-1.5 text-xs shrink-0">
                <Switch checked={!hidden} onCheckedChange={(v) => saveOverride("question", question.id, { hidden: !v })} />
                Shown
              </label>
            )}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing((v) => !v)} aria-label="Edit wording">
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            {isCustom && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={removeCustom} aria-label="Remove custom question">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </>
        )}
      </div>
      {editing && canEdit && (
        <div className="px-3 pb-3 space-y-2">
          <div className="space-y-1">
            <Label className="t-form-label-sm">{isCustom ? "Question label" : "Label for this provider (template: \"" + question.label + "\")"}</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="t-form-label-sm">Help text (optional)</Label>
            <Input value={helpText} onChange={(e) => setHelpText(e.target.value)} />
          </div>
          {isCustom && question.widget === "dropdown" && (
            <div className="space-y-1">
              <Label className="t-form-label-sm">Choices (one per line)</Label>
              <Textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={3} />
            </div>
          )}
          <Button size="sm" disabled={saving} onClick={saveEdits}>
            {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} Save
          </Button>
        </div>
      )}
    </div>
  );
}

function CustomQuestionForm({
  providerId,
  sectionId,
  onDone,
  onCancel,
}: {
  providerId: string;
  sectionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [widget, setWidget] = useState("text");
  const [optionsText, setOptionsText] = useState("");
  const [required, setRequired] = useState(false);
  const [perParent, setPerParent] = useState(false);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      await apiRequest("POST", `/api/ip-form/provider-config/${providerId}/questions`, {
        sectionId,
        label: label.trim(),
        widget,
        options: optionsText.split("\n").map((o) => o.trim()).filter(Boolean),
        required,
        perParent,
      });
      onDone();
    } catch (e: any) {
      toast({ title: "Could not add question", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-[var(--radius)] border border-border bg-secondary/40 p-3 space-y-2" data-testid="provider-form-new-question">
      <div className="grid sm:grid-cols-2 gap-2">
        <div className="space-y-1 sm:col-span-2">
          <Label className="t-form-label-sm">Question label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Do you have pets at home?" autoFocus />
        </div>
        <div className="space-y-1">
          <Label className="t-form-label-sm">Answer type</Label>
          <Select value={widget} onValueChange={setWidget}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {WIDGETS.map((w) => (
                <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {widget === "dropdown" && (
          <div className="space-y-1">
            <Label className="t-form-label-sm">Choices (one per line)</Label>
            <Textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={3} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={required} onCheckedChange={setRequired} /> Required
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={perParent} onCheckedChange={setPerParent} /> Asked per parent
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={saving || !label.trim()} onClick={create}>
            {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />} Add question
          </Button>
        </div>
      </div>
    </div>
  );
}
