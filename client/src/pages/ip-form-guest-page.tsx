/**
 * Intended Parent Form - guest signing page (/ip-form/guest/:token).
 *
 * Parent 2 without a GoStork account opens their private emailed link,
 * reviews the shared sections (read-only for context), fills THEIR
 * per-parent sections, and signs. Shell modeled on the agreements guest
 * signing page; rendering shared with /ip-form via form-shared.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ClipboardList, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SignaturePad } from "@/components/signature-pad";
import {
  AnswerMap,
  IpFormSectionDef,
  SectionQuestions,
  SectionStepper,
  allQuestionsIndex,
  answerKey,
  buildAnswerMap,
  parentSlotHeading,
} from "@/components/ip-form/form-shared";

interface GuestBundle {
  sections: IpFormSectionDef[];
  response: { id: string; status: string; hasSecondParent: boolean };
  answers: { questionId: string; parentSlot: number; value: any }[];
  signatures: { parentSlot: number; fullLegalName: string; signedAt: string; method: string; signatureImageUrl: string }[];
  mySlot: number;
  guestName: string | null;
}

export default function IpFormGuestPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, isLoading, error } = useQuery<GuestBundle>({
    queryKey: [`/api/ip-form/guest/${token}`],
    retry: false,
  });

  const [localAnswers, setLocalAnswers] = useState<AnswerMap>(new Map());
  const dirtyRef = useRef<Map<string, { questionId: string; parentSlot: number; value: any }>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (data?.answers) {
      setLocalAnswers(() => {
        const next = buildAnswerMap(data.answers);
        for (const [key, item] of dirtyRef.current) next.set(key, item.value);
        return next;
      });
    }
  }, [data?.answers]);

  const sections = useMemo(() => (data?.sections || []).filter((s) => s.isActive), [data?.sections]);
  const questionsById = useMemo(() => allQuestionsIndex(sections), [sections]);
  const mySlot = data?.mySlot ?? 2;
  const hasSecondParent = data?.response?.hasSecondParent ?? true;

  const activeKey = searchParams.get("section") || sections[0]?.key || "profile";
  const activeIndex = Math.max(0, sections.findIndex((s) => s.key === activeKey));
  const activeSection = sections[activeIndex];

  const goToSection = useCallback(
    (key: string) => {
      setSearchParams(
        (prev) => {
          prev.set("section", key);
          return prev;
        },
        { replace: true },
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [setSearchParams],
  );

  const flushAnswers = useCallback(async () => {
    const items = [...dirtyRef.current.values()];
    if (!items.length) return;
    dirtyRef.current = new Map();
    setSaveState("saving");
    try {
      await apiRequest("PATCH", `/api/ip-form/guest/${token}/answers`, { answers: items });
      setSaveState("saved");
    } catch {
      for (const item of items) dirtyRef.current.set(answerKey(item.questionId, item.parentSlot), item);
      setSaveState("error");
    }
  }, [token]);

  const onAnswer = useCallback(
    (questionId: string, slot: number, value: any) => {
      setLocalAnswers((prev) => {
        const next = new Map(prev);
        next.set(answerKey(questionId, slot), value);
        return next;
      });
      dirtyRef.current.set(answerKey(questionId, slot), { questionId, parentSlot: slot, value });
      setSaveState("saving");
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => void flushAnswers(), 800);
    },
    [flushAnswers],
  );

  // Guests edit ONLY their own slot's per-parent questions.
  const canEdit = useCallback(
    (question: IpFormSectionDef["questions"][number], slot: number) => {
      if (!activeSection) return false;
      return (activeSection.perParent || question.perParent) && slot === mySlot;
    },
    [activeSection, mySlot],
  );

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <Card className="p-8 max-w-md text-center space-y-2">
          <h1 className="text-xl font-heading font-bold">This link is no longer valid</h1>
          <p className="text-sm text-muted-foreground">
            It may have expired, been replaced by a newer link, or the form was already submitted. Ask your partner to send a fresh link
            from their GoStork account.
          </p>
        </Card>
      </div>
    );
  }

  const mySignature = data.signatures.find((s) => s.parentSlot === mySlot);
  const ackSection = sections.find((s) => s.key === "acknowledgment");
  const legalText = (ackSection?.description || "").replace(/\{\{AGENCY_NAME\}\}/g, "your surrogacy agency");

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-6 pb-24" data-testid="ip-form-guest-page">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <ClipboardList className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-heading font-bold">Intended Parent Form</h1>
            <p className="text-sm text-muted-foreground">
              {data.guestName ? `Hi ${data.guestName}! ` : ""}Your partner started this form. Please review it, complete the sections
              marked Intended Parent {mySlot}, and sign at the end. Shared sections are shown for context and are edited by your partner.
            </p>
          </div>
        </div>

        {mySignature && (
          <Card className="p-4 mb-4 bg-secondary border-primary/30 flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-primary shrink-0" />
            <p className="text-sm">
              You signed on {new Date(mySignature.signedAt).toLocaleDateString()}. You can still update your sections until the form is
              submitted.
            </p>
          </Card>
        )}

        <SectionStepper
          sections={sections}
          activeKey={activeSection?.key || activeKey}
          onSelect={goToSection}
          answers={localAnswers}
          hasSecondParent={hasSecondParent}
          signaturesDone={!!mySignature}
        />

        {activeSection && (
          <Card className="p-5 mt-3 space-y-6">
            <h2 className="text-xl font-heading font-semibold text-primary">{activeSection.title}</h2>

            {activeSection.key === "acknowledgment" ? (
              <div className="space-y-6">
                <p className="text-sm leading-relaxed">{legalText}</p>
                <div className="space-y-3 rounded-[var(--radius)] border border-border p-4">
                  <h3 className="text-base font-heading font-semibold">{parentSlotHeading(mySlot)}</h3>
                  {mySignature ? (
                    <div className="space-y-1">
                      <img src={mySignature.signatureImageUrl} alt="Signature" className="h-14 object-contain" />
                      <p className="text-sm">
                        Signed by <span className="font-medium">{mySignature.fullLegalName}</span> on {new Date(mySignature.signedAt).toLocaleDateString()}
                      </p>
                    </div>
                  ) : (
                    <GuestSignBlock token={token!} defaultName={data.guestName || ""} onSigned={() => queryClient.invalidateQueries({ queryKey: [`/api/ip-form/guest/${token}`] })} />
                  )}
                </div>
              </div>
            ) : (
              <SectionQuestions
                section={activeSection}
                answers={localAnswers}
                onAnswer={onAnswer}
                hasSecondParent={hasSecondParent}
                canEdit={canEdit}
                allQuestionsById={questionsById}
              />
            )}

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button type="button" variant="outline" disabled={activeIndex === 0} onClick={() => goToSection(sections[activeIndex - 1].key)}>
                <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
              </Button>
              {activeIndex < sections.length - 1 && (
                <Button type="button" onClick={() => goToSection(sections[activeIndex + 1].key)}>
                  Next <ArrowRight className="w-4 h-4 ml-1.5" />
                </Button>
              )}
            </div>
          </Card>
        )}

        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
          <div className="rounded-full bg-background border border-border shadow-md px-4 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
            {saveState === "saving" && (<><Loader2 className="w-3 h-3 animate-spin" /> Saving...</>)}
            {saveState === "saved" && (<><Check className="w-3 h-3 text-primary" /> Saved</>)}
            {saveState === "error" && <span className="text-destructive">Save failed - check your connection</span>}
            {saveState === "idle" && "Autosave is on"}
          </div>
        </div>
      </div>
    </div>
  );
}

function GuestSignBlock({ token, defaultName, onSigned }: { token: string; defaultName: string; onSigned: () => void }) {
  const { toast } = useToast();
  const [fullLegalName, setFullLegalName] = useState(defaultName);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5 max-w-md">
        <Label className="text-sm font-medium">Your full legal name</Label>
        <Input value={fullLegalName} onChange={(e) => setFullLegalName(e.target.value)} data-testid="ipform-guest-legal-name" />
      </div>
      <SignaturePad
        typedNameDefault={fullLegalName}
        upload={async (canvas) => canvas.toDataURL("image/png")}
        onSign={async ({ signatureImageUrl, method }) => {
          if (!fullLegalName.trim()) throw new Error("Please enter your full legal name first");
          // signatureImageUrl carries the data URL here - the token endpoint
          // stores it server-side (guests cannot use POST /api/uploads).
          await apiRequest("POST", `/api/ip-form/guest/${token}/sign`, { fullLegalName: fullLegalName.trim(), signatureImageDataUrl: signatureImageUrl, method });
          toast({ title: "Signature saved", description: "Thank you! Your partner can now submit the form." });
          onSigned();
        }}
      />
    </div>
  );
}
