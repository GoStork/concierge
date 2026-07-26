/**
 * GoStork admin - Intended Parent Form template editor (/admin/ip-form-template).
 *
 * The IpFormSection/IpFormQuestion tables are the single source of truth for
 * the form every parent fills. Admins add/edit/reorder/deactivate sections
 * and questions, pick widget types, mark required / per-parent / hidden-
 * from-surrogate-PDF, and attach conditional follow-ups ("If yes, please
 * explain"). Delete is always soft (isActive) - historical answers keep
 * their questions. Inline editing, no dialogs.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
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
  { value: "photos", label: "Photo upload" },
  { value: "file", label: "File upload (image / PDF)" },
];

interface AdminQuestion {
  id: string;
  sectionId: string;
  key: string;
  label: string;
  helpText: string | null;
  widget: string;
  options: string[] | null;
  required: boolean;
  perParent: boolean;
  excludeFromSurrogatePdf: boolean;
  conditionalOnQuestionId: string | null;
  conditionalTriggerValue: string | null;
  sortOrder: number;
  isActive: boolean;
}

interface AdminSection {
  id: string;
  key: string;
  title: string;
  description: string | null;
  perParent: boolean;
  excludeFromSurrogatePdf: boolean;
  appliesTo: string[];
  sortOrder: number;
  isActive: boolean;
  questions: AdminQuestion[];
}

export default function AdminIpFormTemplatePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const roles: string[] = (user as any)?.roles || [];
  const isAdmin = roles.includes("GOSTORK_ADMIN");

  const { data, isLoading } = useQuery<{ sections: AdminSection[] }>({
    queryKey: ["/api/admin/ip-form-template"],
    enabled: isAdmin,
  });
  const sections = data?.sections || [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/ip-form-template"] });

  if (!isAdmin) {
    return (
      <div className="t-helper max-w-3xl mx-auto px-4 py-16 text-center">GoStork admins only.</div>
    );
  }

  const moveSection = async (index: number, dir: -1 | 1) => {
    const ids = sections.map((s) => s.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await apiRequest("PUT", "/api/admin/ip-form-template/reorder", { sectionIds: ids });
    refresh();
  };

  const addSection = async () => {
    try {
      await apiRequest("POST", "/api/admin/ip-form-sections", { title: "New Section" });
      refresh();
    } catch (e: any) {
      toast({ title: "Could not add section", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 pb-24 md:pb-8" data-testid="admin-ip-form-template-page">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-heading font-bold">Intended Parent Form Template</h1>
          <p className="t-helper">
            The master template every family fills. Changes apply immediately to new answers; deactivating keeps historical answers
            intact. "Hidden from surrogate PDF" controls what the surrogate-safe download strips.
          </p>
        </div>
        <Button onClick={addSection} data-testid="ipform-admin-add-section">
          <Plus className="w-4 h-4 mr-1.5" /> Add section
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        sections.map((section, i) => (
          <SectionEditor
            key={section.id}
            section={section}
            allSections={sections}
            expanded={!!expanded[section.id]}
            onToggle={() => setExpanded((p) => ({ ...p, [section.id]: !p[section.id] }))}
            onMove={(dir) => moveSection(i, dir)}
            canUp={i > 0}
            canDown={i < sections.length - 1}
            refresh={refresh}
          />
        ))
      )}
    </div>
  );
}

function SectionEditor({
  section,
  allSections,
  expanded,
  onToggle,
  onMove,
  canUp,
  canDown,
  refresh,
}: {
  section: AdminSection;
  allSections: AdminSection[];
  expanded: boolean;
  onToggle: () => void;
  onMove: (dir: -1 | 1) => void;
  canUp: boolean;
  canDown: boolean;
  refresh: () => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState(section.title);
  const [description, setDescription] = useState(section.description || "");
  const [saving, setSaving] = useState(false);

  const dirty = title !== section.title || description !== (section.description || "");

  const save = async (patch: any) => {
    setSaving(true);
    try {
      await apiRequest("PUT", `/api/admin/ip-form-sections/${section.id}`, patch);
      refresh();
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const moveQuestion = async (index: number, dir: -1 | 1) => {
    const ids = section.questions.map((q) => q.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await apiRequest("PUT", "/api/admin/ip-form-template/reorder", { questionIdsBySection: { [section.id]: ids } });
    refresh();
  };

  const addQuestion = async () => {
    try {
      await apiRequest("POST", "/api/admin/ip-form-questions", { sectionId: section.id, label: "New question", widget: "text" });
      refresh();
    } catch (e: any) {
      toast({ title: "Could not add question", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <Card className={`p-4 space-y-3 ${section.isActive ? "" : "opacity-60"}`} data-testid={`ipform-admin-section-${section.key}`}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className="p-1 rounded hover:bg-secondary" aria-label="Expand section">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">
            {section.title}
            <span className="t-helper ml-2">
              {section.questions.filter((q) => q.isActive).length} questions
              {section.perParent ? " - per parent" : ""}
              {(section.appliesTo || []).length ? ` - ${(section.appliesTo || []).map((t) => (t === "ivf" ? "IVF" : t)).join(" + ")} only` : " - all programs"}
              {section.excludeFromSurrogatePdf ? " - hidden from surrogate PDF" : ""}
              {section.isActive ? "" : " - INACTIVE"}
            </span>
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={!canUp} onClick={() => onMove(-1)} aria-label="Move up">
          <ArrowUp className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={!canDown} onClick={() => onMove(1)} aria-label="Move down">
          <ArrowDown className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => save({ isActive: !section.isActive })}
          aria-label={section.isActive ? "Deactivate section" : "Activate section"}
        >
          {section.isActive ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-4 pl-7">
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label className="t-form-label-sm">Section title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="t-form-label-sm">Description (shown to parents; acknowledgment legal text lives here - {"{{AGENCY_NAME}}"} is replaced per agency)</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>
            <div className="flex flex-wrap items-center gap-5">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={section.perParent} onCheckedChange={(v) => save({ perParent: v })} /> Repeats per parent
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={section.excludeFromSurrogatePdf} onCheckedChange={(v) => save({ excludeFromSurrogatePdf: v })} /> Hidden from surrogate PDF
              </label>
              {dirty && (
                <Button size="sm" disabled={saving} onClick={() => save({ title, description })}>
                  {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} Save
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm rounded-[var(--radius)] bg-secondary/40 p-2.5">
              <span className="t-helper">Applies to</span>
              {(["surrogacy", "ivf"] as const).map((prog) => {
                const tags = section.appliesTo || [];
                // Core (empty appliesTo) renders as every program ON.
                const on = tags.length === 0 || tags.includes(prog);
                return (
                  <label key={prog} className="flex items-center gap-2 capitalize" data-testid={`ipform-applies-${prog}`}>
                    <Switch
                      checked={on}
                      onCheckedChange={(v) => {
                        const KNOWN = ["surrogacy", "ivf"];
                        const cur = new Set(tags.length ? tags : KNOWN);
                        if (v) cur.add(prog); else cur.delete(prog);
                        // All programs on (or none) collapses back to core ([]).
                        const next = cur.size === 0 || KNOWN.every((k) => cur.has(k)) ? [] : [...cur];
                        save({ appliesTo: next });
                      }}
                    />
                    {prog === "ivf" ? "IVF" : prog}
                  </label>
                );
              })}
              <span className="t-helper">Both on = all programs (core). One on = only that program's parents.</span>
            </div>
          </div>

          <div className="space-y-2">
            {section.questions.map((q, qi) => (
              <QuestionEditor
                key={q.id}
                question={q}
                section={section}
                allSections={allSections}
                onMove={(dir) => moveQuestion(qi, dir)}
                canUp={qi > 0}
                canDown={qi < section.questions.length - 1}
                refresh={refresh}
              />
            ))}
            <Button variant="outline" size="sm" onClick={addQuestion} data-testid={`ipform-admin-add-question-${section.key}`}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Add question
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function QuestionEditor({
  question,
  section,
  allSections,
  onMove,
  canUp,
  canDown,
  refresh,
}: {
  question: AdminQuestion;
  section: AdminSection;
  allSections: AdminSection[];
  onMove: (dir: -1 | 1) => void;
  canUp: boolean;
  canDown: boolean;
  refresh: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(question.label);
  const [helpText, setHelpText] = useState(question.helpText || "");
  const [optionsText, setOptionsText] = useState((question.options || []).join("\n"));
  const [trigger, setTrigger] = useState(question.conditionalTriggerValue || "");
  const [saving, setSaving] = useState(false);

  const save = async (patch: any) => {
    setSaving(true);
    try {
      await apiRequest("PUT", `/api/admin/ip-form-questions/${question.id}`, patch);
      refresh();
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saveText = () =>
    save({
      label,
      helpText,
      options: optionsText.split("\n").map((o) => o.trim()).filter(Boolean),
      conditionalTriggerValue: trigger || null,
    });

  // Candidate parent questions for conditionals: same section, not itself.
  const conditionCandidates = section.questions.filter((q) => q.id !== question.id);

  return (
    <div className={`rounded-[var(--radius)] border border-border ${question.isActive ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="p-0.5 rounded hover:bg-secondary" aria-label="Expand question">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <p className="flex-1 min-w-0 text-sm truncate">
          {question.label}
          <span className="t-helper ml-2">
            {WIDGETS.find((w) => w.value === question.widget)?.label || question.widget}
            {question.required ? " - required" : ""}
            {question.perParent ? " - per parent" : ""}
            {question.conditionalOnQuestionId ? " - conditional" : ""}
            {question.isActive ? "" : " - INACTIVE"}
          </span>
        </p>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!canUp} onClick={() => onMove(-1)} aria-label="Move up">
          <ArrowUp className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!canDown} onClick={() => onMove(1)} aria-label="Move down">
          <ArrowDown className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => save({ isActive: !question.isActive })}
          aria-label={question.isActive ? "Deactivate question" : "Activate question"}
        >
          {question.isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {open && (
        <div className="px-3 pb-3 pl-9 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label className="t-form-label-sm">Question label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="t-form-label-sm">Help text (optional)</Label>
              <Input value={helpText} onChange={(e) => setHelpText(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="t-form-label-sm">Answer type</Label>
              <Select value={question.widget} onValueChange={(v) => save({ widget: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WIDGETS.map((w) => (
                    <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {question.widget === "dropdown" && (
              <div className="space-y-1">
                <Label className="t-form-label-sm">Choices (one per line)</Label>
                <Textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={3} />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={question.required} onCheckedChange={(v) => save({ required: v })} /> Required
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={question.perParent} onCheckedChange={(v) => save({ perParent: v })} /> Asked per parent
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={question.excludeFromSurrogatePdf} onCheckedChange={(v) => save({ excludeFromSurrogatePdf: v })} /> Hidden from surrogate PDF
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="t-form-label-sm">Show only when this question...</Label>
              <Select
                value={question.conditionalOnQuestionId || "none"}
                onValueChange={(v) => save({ conditionalOnQuestionId: v === "none" ? null : v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Always shown</SelectItem>
                  {conditionCandidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {question.conditionalOnQuestionId && (
              <div className="space-y-1">
                <Label className="t-form-label-sm">...is answered with</Label>
                <Input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder='e.g. "yes"' />
              </div>
            )}
          </div>

          <Button size="sm" disabled={saving} onClick={saveText}>
            {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} Save question
          </Button>
        </div>
      )}
    </div>
  );
}
