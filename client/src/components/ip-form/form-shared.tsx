/**
 * Intended Parent Form - shared rendering used by BOTH the parent page
 * (/ip-form) and the guest signing page (/ip-form/guest/:token). Never fork:
 * section layout, conditional visibility, completion math, and the stepper
 * live here; the pages only differ in data wiring and edit scope.
 */
import { Check, Lock } from "lucide-react";
import { QuestionField, IpFormQuestionDef } from "@/components/ip-form/question-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export interface IpFormSectionDef {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  perParent: boolean;
  excludeFromSurrogatePdf: boolean;
  isActive: boolean;
  questions: (IpFormQuestionDef & {
    perParent: boolean;
    conditionalOnQuestionId?: string | null;
    conditionalTriggerValue?: string | null;
    isActive: boolean;
    sortOrder: number;
  })[];
}

export interface IpFormAnswerRow {
  questionId: string;
  parentSlot: number;
  value: any;
}

export type AnswerMap = Map<string, any>;

export const answerKey = (questionId: string, slot: number) => `${questionId}:${slot}`;

export function buildAnswerMap(answers: IpFormAnswerRow[]): AnswerMap {
  const map = new Map<string, any>();
  for (const a of answers) map.set(answerKey(a.questionId, a.parentSlot || 0), a.value);
  return map;
}

const normalized = (v: any) => (v == null ? "" : String(v).trim().toLowerCase());

export function isAnswerEmpty(value: any): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value).every((v) => v == null || String(v).trim() === "");
  return false;
}

/** Slots a question renders for. Shared -> [0]; per-parent -> [1] or [1,2]. */
export function slotsFor(section: IpFormSectionDef, question: { perParent: boolean }, hasSecondParent: boolean): number[] {
  if (section.perParent || question.perParent) return hasSecondParent ? [1, 2] : [1];
  return [0];
}

/** Conditional follow-up visibility for a given slot. */
export function isQuestionVisible(
  section: IpFormSectionDef,
  question: IpFormSectionDef["questions"][number],
  slot: number,
  answers: AnswerMap,
  allQuestionsById: Map<string, IpFormSectionDef["questions"][number]>,
): boolean {
  if (!question.conditionalOnQuestionId) return true;
  const parent = allQuestionsById.get(question.conditionalOnQuestionId);
  const parentSlot = parent && (section.perParent || parent.perParent) ? slot : 0;
  return normalized(answers.get(answerKey(question.conditionalOnQuestionId, parentSlot))) === normalized(question.conditionalTriggerValue);
}

/** Required-and-visible questions still missing in one section (for ticks + submit gating). */
export function sectionMissingCount(
  section: IpFormSectionDef,
  answers: AnswerMap,
  hasSecondParent: boolean,
  allQuestionsById: Map<string, IpFormSectionDef["questions"][number]>,
): number {
  let missing = 0;
  for (const q of section.questions) {
    if (!q.isActive || !q.required) continue;
    for (const slot of slotsFor(section, q, hasSecondParent)) {
      if (!isQuestionVisible(section, q, slot, answers, allQuestionsById)) continue;
      if (isAnswerEmpty(answers.get(answerKey(q.id, slot)))) missing++;
    }
  }
  return missing;
}

export function allQuestionsIndex(sections: IpFormSectionDef[]): Map<string, IpFormSectionDef["questions"][number]> {
  const map = new Map<string, IpFormSectionDef["questions"][number]>();
  for (const s of sections) for (const q of s.questions) map.set(q.id, q);
  return map;
}

/** Horizontal section stepper with completion ticks. */
export function SectionStepper({
  sections,
  activeKey,
  onSelect,
  answers,
  hasSecondParent,
  signaturesDone,
}: {
  sections: IpFormSectionDef[];
  activeKey: string;
  onSelect: (key: string) => void;
  answers: AnswerMap;
  hasSecondParent: boolean;
  signaturesDone: boolean;
}) {
  const byId = allQuestionsIndex(sections);
  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-2 -mx-1 px-1" data-testid="ipform-stepper">
      {sections.map((s, i) => {
        const complete = s.key === "acknowledgment" ? signaturesDone : s.questions.length > 0 && sectionMissingCount(s, answers, hasSecondParent, byId) === 0;
        const active = s.key === activeKey;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(s.key)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border font-ui transition-colors ${
              active
                ? "bg-primary text-primary-foreground border-primary"
                : complete
                ? "bg-secondary text-foreground border-border"
                : "bg-background text-muted-foreground border-border hover:border-primary/50"
            }`}
            data-testid={`ipform-step-${s.key}`}
          >
            {complete && !active ? <Check className="w-3.5 h-3.5 text-primary" /> : <span className="text-xs">{i + 1}.</span>}
            {s.title}
          </button>
        );
      })}
    </div>
  );
}

export function parentSlotHeading(slot: number, memberNames?: Partial<Record<number, string | null>>): string {
  const name = memberNames?.[slot];
  return name ? `Intended Parent ${slot} - ${name}` : `Intended Parent ${slot}`;
}

// Marital statuses that imply a second intended parent (mirror of the server's
// maritalImpliesTwoParents). Only used to choose the escape-hatch label/mode.
const TWO_PARENT_MARITAL = ["Partnered", "Married"];

/**
 * Escape hatch for the rare mismatch between relationship status and who is
 * actually on the journey, rendered right under IP1's marital status:
 *  - Married/Partnered: "I'm [married/partnered] but on my own" -> hides IP2.
 *  - Single/Separated/Divorced/Widowed: "I have a second intended parent" -> shows IP2.
 * Hidden until a status is picked.
 */
function SecondParentToggle({
  maritalStatus,
  hasSecondParent,
  onSet,
}: {
  maritalStatus: any;
  hasSecondParent: boolean;
  onSet: (v: boolean) => void;
}) {
  const status = typeof maritalStatus === "string" ? maritalStatus.trim() : "";
  if (!status) return null;
  const impliesTwo = TWO_PARENT_MARITAL.includes(status);
  const label = impliesTwo
    ? `I'm ${status.toLowerCase()}, but I'm pursuing this journey on my own`
    : "I have a second intended parent on this journey";
  // impliesTwo: checkbox means "solo" (checked => hasSecondParent false).
  // else: checkbox means "add a second parent" (checked => hasSecondParent true).
  const checked = impliesTwo ? !hasSecondParent : hasSecondParent;
  return (
    <label className="mt-2 flex items-start gap-2 text-sm text-muted-foreground cursor-pointer" data-testid="ipform-second-parent-toggle">
      <Checkbox
        checked={checked}
        onCheckedChange={(c) => onSet(impliesTwo ? !c : !!c)}
        className="mt-0.5"
        data-testid="ipform-second-parent-checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function addressHasContent(v: any): boolean {
  if (!v || typeof v !== "object") return false;
  return ["address", "city", "state", "zip", "country", "apt"].some((k) => v[k] && String(v[k]).trim());
}

/**
 * Mailing address with a "Same as residential address" checkbox (default on).
 * When checked, the mailing answer holds only { sameAsResidential: true } and
 * the residential address is resolved at render/PDF time (single source of
 * truth, no copy drift). When unchecked, it's a normal address field.
 */
function MailingAddressField({
  question,
  value,
  residentialValue,
  onChange,
  disabled,
}: {
  question: IpFormSectionDef["questions"][number];
  value: any;
  residentialValue: any;
  onChange: (value: any) => void;
  disabled?: boolean;
}) {
  const flag = value?.sameAsResidential;
  // Explicit flag wins; with no flag, default to "same" unless a real (legacy)
  // different address was already entered.
  const sameAs = flag === true ? true : flag === false ? false : !addressHasContent(value);
  const editValue = value && !value.sameAsResidential ? value : undefined;
  return (
    <div className="space-y-1.5" data-testid="ipform-mailing-address">
      <Label className="text-sm font-medium leading-snug">
        {question.label}
        {question.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
        <Checkbox
          checked={sameAs}
          disabled={disabled}
          onCheckedChange={(c) => onChange(c ? { sameAsResidential: true } : { address: "", city: "", state: "", zip: "", country: "", apt: "", sameAsResidential: false })}
          data-testid="ipform-mailing-same-as-residential"
        />
        Same as residential address
      </label>
      {!sameAs && (
        <QuestionField
          question={question}
          value={editValue}
          onChange={(v) => onChange({ ...v, sameAsResidential: false })}
          disabled={disabled}
          hideLabel
        />
      )}
    </div>
  );
}

/**
 * One section's question list. `canEdit(question, slot)` decides field
 * editability (member vs guest vs submitted); non-editable fields render
 * disabled with a lock hint on per-parent blocks the viewer can't touch.
 */
export function SectionQuestions({
  section,
  answers,
  onAnswer,
  hasSecondParent,
  canEdit,
  allQuestionsById,
  memberNames,
  secondParentControl,
}: {
  section: IpFormSectionDef;
  answers: AnswerMap;
  onAnswer: (questionId: string, slot: number, value: any) => void;
  hasSecondParent: boolean;
  canEdit: (question: IpFormSectionDef["questions"][number], slot: number) => boolean;
  allQuestionsById: Map<string, IpFormSectionDef["questions"][number]>;
  memberNames?: Partial<Record<number, string | null>>;
  // When provided (parent page only), the two-vs-solo escape hatch renders as
  // a checkbox under IP1's relationship status. Guests never get it.
  secondParentControl?: { hasSecondParent: boolean; onSet: (v: boolean) => void };
}) {
  const activeQuestions = section.questions.filter((q) => q.isActive);
  const perParentQs = activeQuestions.filter((q) => q.perParent);
  const sharedQs = activeQuestions.filter((q) => !q.perParent);
  const slots = hasSecondParent ? [1, 2] : [1];

  const residentialQ = section.questions.find((q) => q.key === "ip_residential_address");

  const renderList = (questions: typeof activeQuestions, slot: number) => (
    <div className="space-y-5">
      {questions.map((q) => {
        if (!isQuestionVisible(section, q, slot, answers, allQuestionsById)) return null;
        const editable = canEdit(q, slot);
        const indent = !!q.conditionalOnQuestionId;
        // Mailing address gets a "same as residential" checkbox (default on)
        // so parents don't retype the residential address.
        if (q.key === "ip_mailing_address" && residentialQ) {
          return (
            <div key={`${q.id}:${slot}`}>
              <MailingAddressField
                question={q}
                value={answers.get(answerKey(q.id, slot))}
                residentialValue={answers.get(answerKey(residentialQ.id, slot))}
                onChange={(v) => onAnswer(q.id, slot, v)}
                disabled={!editable}
              />
            </div>
          );
        }
        return (
          <div key={`${q.id}:${slot}`} className={indent ? "pl-4 border-l-2 border-secondary" : undefined}>
            <QuestionField
              question={q}
              value={answers.get(answerKey(q.id, slot))}
              onChange={(v) => onAnswer(q.id, slot, v)}
              disabled={!editable}
            />
            {/* Two-vs-solo escape hatch: directly under IP1's relationship
                status, only when it implies a partner (or to add one back). */}
            {q.key === "ip_marital_status" && slot === 1 && secondParentControl && (
              <SecondParentToggle
                maritalStatus={answers.get(answerKey(q.id, 1))}
                hasSecondParent={secondParentControl.hasSecondParent}
                onSet={secondParentControl.onSet}
              />
            )}
          </div>
        );
      })}
    </div>
  );

  if (section.perParent) {
    return (
      <div className="space-y-8">
        {section.description && <p className="text-sm text-muted-foreground">{section.description}</p>}
        {slots.map((slot) => {
          const anyEditable = activeQuestions.some((q) => canEdit(q, slot));
          return (
            <div key={slot} className="space-y-4">
              <h3 className="text-base font-heading font-semibold flex items-center gap-2">
                {parentSlotHeading(slot, memberNames)}
                {!anyEditable && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
              </h3>
              {renderList(activeQuestions, slot)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {section.description && <p className="text-sm text-muted-foreground">{section.description}</p>}
      {perParentQs.length > 0 &&
        slots.map((slot) => {
          const anyEditable = perParentQs.some((q) => canEdit(q, slot));
          return (
            <div key={slot} className="space-y-4">
              <h3 className="text-base font-heading font-semibold flex items-center gap-2">
                {parentSlotHeading(slot, memberNames)}
                {!anyEditable && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
              </h3>
              {renderList(perParentQs, slot)}
            </div>
          );
        })}
      {sharedQs.length > 0 && (
        <div className="space-y-5">
          {perParentQs.length > 0 && <h3 className="text-base font-heading font-semibold">Shared Details</h3>}
          {renderList(sharedQs, 0)}
        </div>
      )}
    </div>
  );
}
