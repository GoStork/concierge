/**
 * Intended Parent Form (/ip-form).
 *
 * The profile form surrogacy agencies share with potential surrogates ahead
 * of a match call. Sectioned single page with a stepper (state in ?section=,
 * {replace:true} per the tab-state rule), debounced batched autosave, native
 * per-parent signatures, invite-parent-2 (account member OR guest link), and
 * submit with per-section validation. Shared rendering lives in
 * components/ip-form/form-shared.tsx (also used by the guest page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  Link2,
  Loader2,
  Mail,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
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
  sectionMissingCount,
} from "@/components/ip-form/form-shared";

interface IpFormBundle {
  sections: IpFormSectionDef[];
  response: { id: string; status: string; hasSecondParent: boolean; hasSecondParentManual: boolean; parent2Mode: string | null; submittedAt: string | null };
  answers: { questionId: string; parentSlot: number; value: any }[];
  signatures: { parentSlot: number; fullLegalName: string; signedAt: string; method: string; signatureImageUrl: string }[];
  mySlot: 1 | 2 | null;
  guestInvite: { email: string; name: string | null; createdAt: string; expiresAt: string } | null;
  members: { id: string; name: string | null; email: string; parentAccountRole: string | null }[];
}

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < 12; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

export default function IpFormPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, isLoading } = useQuery<IpFormBundle>({
    queryKey: ["/api/ip-form"],
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  // Local answers overlay server answers so typing stays snappy; dirty keys
  // flush to the server on an 800ms debounce.
  const [localAnswers, setLocalAnswers] = useState<AnswerMap>(new Map());
  const dirtyRef = useRef<Map<string, { questionId: string; parentSlot: number; value: any }>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [missingBySection, setMissingBySection] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (data?.answers) {
      setLocalAnswers((prev) => {
        const next = buildAnswerMap(data.answers);
        // Keep unflushed local edits on top of the refetched snapshot.
        for (const [key, item] of dirtyRef.current) next.set(key, item.value);
        return next;
      });
    }
  }, [data?.answers]);

  const sections = useMemo(() => (data?.sections || []).filter((s) => s.isActive), [data?.sections]);
  const questionsById = useMemo(() => allQuestionsIndex(sections), [sections]);
  const submitted = data?.response?.status === "SUBMITTED";
  const hasSecondParent = data?.response?.hasSecondParent ?? true;
  const mySlot = data?.mySlot ?? null;
  const isViewer = mySlot == null;

  const memberNames = useMemo(() => {
    const names: Partial<Record<number, string | null>> = {};
    for (const m of data?.members || []) {
      if (m.parentAccountRole === "INTENDED_PARENT_2") names[2] = m.name;
      else if (m.parentAccountRole !== "VIEWER") names[1] = names[1] || m.name;
    }
    if (data?.guestInvite?.name) names[2] = names[2] || data.guestInvite.name;
    return names;
  }, [data?.members, data?.guestInvite]);

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
      const res = await apiRequest("PATCH", "/api/ip-form/answers", { answers: items });
      // The server re-derives two-vs-solo from IP1's marital status and hands
      // the fresh value back - apply it so the second-parent sections appear
      // or vanish right after the parent picks their relationship status.
      const body = await res.json().catch(() => null);
      if (body?.response) {
        queryClient.setQueryData<IpFormBundle>(["/api/ip-form"], (old) =>
          old ? { ...old, response: { ...old.response, hasSecondParent: body.response.hasSecondParent, hasSecondParentManual: body.response.hasSecondParentManual } } : old,
        );
      }
      setSaveState("saved");
    } catch (e: any) {
      // Re-queue so nothing is lost; surface the failure.
      for (const item of items) dirtyRef.current.set(answerKey(item.questionId, item.parentSlot), item);
      setSaveState("error");
    }
  }, []);

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

  // Flush pending edits when the tab hides / unmounts.
  useEffect(() => {
    const flush = () => void flushAnswers();
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
      void flushAnswers();
    };
  }, [flushAnswers]);

  const canEdit = useCallback(
    (question: IpFormSectionDef["questions"][number], slot: number) => {
      if (submitted || isViewer) return false;
      // Private ID block: each parent edits only their own document details.
      if (activeSection?.key === "private" && (question.perParent || activeSection.perParent) && slot !== mySlot) return false;
      return true;
    },
    [submitted, isViewer, activeSection, mySlot],
  );

  const signaturesDone =
    !!data?.signatures?.find((s) => s.parentSlot === 1) && (!hasSecondParent || !!data?.signatures?.find((s) => s.parentSlot === 2));

  // Escape hatch: explicitly set two-vs-solo, overriding the marital-status
  // inference. Optimistically update so the sections show/hide immediately.
  const setSecondParent = async (value: boolean) => {
    queryClient.setQueryData<IpFormBundle>(["/api/ip-form"], (old) =>
      old ? { ...old, response: { ...old.response, hasSecondParent: value, hasSecondParentManual: true } } : old,
    );
    try {
      await apiRequest("PATCH", "/api/ip-form", { hasSecondParent: value });
    } catch (e: any) {
      toast({ title: "Could not update", description: e?.message, variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["/api/ip-form"] });
    }
  };

  const submitForm = async () => {
    await flushAnswers();
    setSubmitting(true);
    setMissingBySection(null);
    try {
      await apiRequest("POST", "/api/ip-form/submit");
      queryClient.invalidateQueries({ queryKey: ["/api/ip-form"] });
      queryClient.invalidateQueries({ queryKey: ["/api/my/dashboard-queue"] });
      toast({ title: "Form submitted!", description: "Your surrogacy agency has been notified. Thank you!" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(String(e?.message || "").replace(/^\d+:\s*/, ""));
      } catch { /* plain error */ }
      if (parsed?.missing || parsed?.missingSignatures?.length) {
        const counts: Record<string, number> = {};
        for (const m of parsed.missing || []) counts[m.sectionKey] = (counts[m.sectionKey] || 0) + 1;
        if (parsed.missingSignatures?.length) counts["acknowledgment"] = parsed.missingSignatures.length;
        setMissingBySection(counts);
        toast({
          title: "Almost there",
          description: "A few required answers are still missing - the incomplete sections are highlighted below.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Could not submit", description: parsed?.message || e?.message, variant: "destructive" });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-28" data-testid="ip-form-page">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-heading font-bold">Intended Parent Form</h1>
          <p className="text-sm text-muted-foreground">
            Your surrogacy agency shares this form (with your photos and letter) with potential surrogates so they can get to know your
            family before a match call. It saves automatically - finish it in as many sittings as you need.
          </p>
        </div>
      </div>

      {submitted && (
        <Card className="p-4 mb-4 bg-secondary border-primary/30 flex items-center gap-3" data-testid="ipform-submitted-banner">
          <CheckCircle2 className="w-6 h-6 text-primary shrink-0" />
          <div>
            <p className="font-semibold">Submitted{data.response.submittedAt ? ` on ${new Date(data.response.submittedAt).toLocaleDateString()}` : ""}. You're all set!</p>
            <p className="text-sm text-muted-foreground">Your agency can now share your profile with potential surrogates. The form is locked - contact your agency if something needs to change.</p>
          </div>
        </Card>
      )}

      {isViewer && !submitted && (
        <Card className="p-4 mb-4 bg-secondary/60">
          <p className="text-sm text-muted-foreground">You have view-only access on this account - the intended parents fill and sign this form.</p>
        </Card>
      )}

      <SectionStepper
        sections={sections}
        activeKey={activeSection?.key || activeKey}
        onSelect={goToSection}
        answers={localAnswers}
        hasSecondParent={hasSecondParent}
        signaturesDone={signaturesDone}
      />

      {missingBySection && missingBySection[activeSection?.key || ""] == null && Object.keys(missingBySection).length > 0 && (
        <Card className="p-3 my-3 border-brand-warning/50 bg-secondary/40">
          <p className="text-sm">
            Missing answers in: {Object.entries(missingBySection).map(([k, n]) => `${sections.find((s) => s.key === k)?.title || k} (${n})`).join(", ")}
          </p>
        </Card>
      )}

      {activeSection && (
        <Card className="p-5 mt-3 space-y-6">
          <div>
            <h2 className="text-xl font-heading font-semibold text-primary">{activeSection.title}</h2>
            {missingBySection?.[activeSection.key] != null && (
              <p className="text-sm text-destructive mt-1">{missingBySection[activeSection.key]} required answer(s) still missing in this section.</p>
            )}
          </div>

          {activeSection.key === "acknowledgment" ? (
            <AcknowledgmentSection
              data={data}
              hasSecondParent={hasSecondParent}
              mySlot={mySlot}
              submitted={submitted}
              memberNames={memberNames}
              localAnswers={localAnswers}
              questionsById={questionsById}
            />
          ) : (
            <SectionQuestions
              section={activeSection}
              answers={localAnswers}
              onAnswer={onAnswer}
              hasSecondParent={hasSecondParent}
              canEdit={canEdit}
              allQuestionsById={questionsById}
              memberNames={memberNames}
              /* The two-vs-solo escape hatch renders as a checkbox right under
                 IP1's relationship status (see SectionQuestions). No control
                 for viewers or after submit. */
              secondParentControl={!submitted && !isViewer ? { hasSecondParent, onSet: setSecondParent } : undefined}
            />
          )}

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <Button type="button" variant="outline" disabled={activeIndex === 0} onClick={() => goToSection(sections[activeIndex - 1].key)} data-testid="ipform-back">
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
            </Button>
            {activeIndex < sections.length - 1 ? (
              <Button type="button" onClick={() => goToSection(sections[activeIndex + 1].key)} data-testid="ipform-next">
                Next <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            ) : (
              !submitted && (
                <Button type="button" onClick={submitForm} disabled={submitting || isViewer} data-testid="ipform-submit">
                  {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                  Submit Form
                </Button>
              )
            )}
          </div>
        </Card>
      )}

      {!submitted && (
        <div className="fixed bottom-16 md:bottom-4 left-1/2 -translate-x-1/2 z-40">
          <div className="rounded-full bg-background border border-border shadow-md px-4 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5" data-testid="ipform-save-state">
            {saveState === "saving" && (<><Loader2 className="w-3 h-3 animate-spin" /> Saving...</>)}
            {saveState === "saved" && (<><Check className="w-3 h-3 text-primary" /> Saved</>)}
            {saveState === "error" && <span className="text-destructive">Save failed - check your connection</span>}
            {saveState === "idle" && "Autosave is on"}
          </div>
        </div>
      )}
    </div>
  );
}

/** Legal text + per-parent signature blocks + parent-2 invite options. */
function AcknowledgmentSection({
  data,
  hasSecondParent,
  mySlot,
  submitted,
  memberNames,
  localAnswers,
  questionsById,
}: {
  data: IpFormBundle;
  hasSecondParent: boolean;
  mySlot: 1 | 2 | null;
  submitted: boolean;
  memberNames: Partial<Record<number, string | null>>;
  localAnswers: AnswerMap;
  questionsById: Map<string, IpFormSectionDef["questions"][number]>;
}) {
  const { toast } = useToast();
  const ackSection = data.sections.find((s) => s.key === "acknowledgment");
  const legalText = (ackSection?.description || "").replace(/\{\{AGENCY_NAME\}\}/g, "your surrogacy agency");
  const slots = hasSecondParent ? [1, 2] : [1];

  // Prefill the signer's legal name from the profile section answer.
  const nameFor = (slot: number) => {
    for (const [, q] of questionsById) {
      if (q.key === "ip_full_legal_name") return (localAnswers.get(answerKey(q.id, slot)) as string) || "";
    }
    return "";
  };

  const sign = async (slot: number, fullLegalName: string, signatureImageUrl: string, method: "drawn" | "typed") => {
    await apiRequest("POST", "/api/ip-form/sign", { fullLegalName, signatureImageUrl, method });
    queryClient.invalidateQueries({ queryKey: ["/api/ip-form"] });
    toast({ title: "Signature saved", description: `Signed as ${fullLegalName}.` });
  };

  return (
    <div className="space-y-8">
      <p className="text-sm leading-relaxed">{legalText}</p>
      {slots.map((slot) => {
        const signature = data.signatures.find((s) => s.parentSlot === slot);
        const mine = slot === mySlot;
        return (
          <div key={slot} className="space-y-3 rounded-[var(--radius)] border border-border p-4">
            <h3 className="text-base font-heading font-semibold">{parentSlotHeading(slot, memberNames)}</h3>
            {signature ? (
              <div className="space-y-1" data-testid={`ipform-signed-${slot}`}>
                <img src={signature.signatureImageUrl} alt="Signature" className="h-14 object-contain" />
                <p className="text-sm">
                  Signed by <span className="font-medium">{signature.fullLegalName}</span> on {new Date(signature.signedAt).toLocaleDateString()}
                </p>
                {mine && !submitted && <p className="text-xs text-muted-foreground">Sign again below to replace your signature.</p>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Not signed yet.</p>
            )}
            {mine && !submitted && <SignBlock defaultName={nameFor(slot)} onSign={(name, url, method) => sign(slot, name, url, method)} />}
            {!mine && slot === 2 && !signature && !submitted && mySlot === 1 && <InviteParent2Panel data={data} />}
          </div>
        );
      })}
    </div>
  );
}

function SignBlock({ defaultName, onSign }: { defaultName: string; onSign: (name: string, url: string, method: "drawn" | "typed") => Promise<void> }) {
  const [fullLegalName, setFullLegalName] = useState(defaultName);
  useEffect(() => setFullLegalName((prev) => prev || defaultName), [defaultName]);
  return (
    <div className="space-y-3 pt-1">
      <div className="space-y-1.5 max-w-md">
        <Label className="text-sm font-medium">Your full legal name</Label>
        <Input value={fullLegalName} onChange={(e) => setFullLegalName(e.target.value)} data-testid="ipform-legal-name" />
      </div>
      <SignaturePad
        typedNameDefault={fullLegalName}
        onSign={async ({ signatureImageUrl, method }) => {
          if (!fullLegalName.trim()) throw new Error("Please enter your full legal name first");
          await onSign(fullLegalName.trim(), signatureImageUrl, method);
        }}
      />
    </div>
  );
}

/** Two inline options for getting parent 2's sections + signature. */
function InviteParent2Panel({ data }: { data: IpFormBundle }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"member" | "guest" | null>(null);
  const [name, setName] = useState(data.guestInvite?.name || "");
  const [email, setEmail] = useState(data.guestInvite?.email || "");
  const [busy, setBusy] = useState(false);
  const [guestLink, setGuestLink] = useState<string | null>(null);

  const hasMember2 = data.members.some((m) => m.parentAccountRole === "INTENDED_PARENT_2");

  const inviteMember = async () => {
    setBusy(true);
    try {
      if (!hasMember2) {
        const password = generateTempPassword();
        await apiRequest("POST", "/api/parent-account/members", { email: email.trim(), name: name.trim() || undefined, password });
      }
      await apiRequest("POST", "/api/ip-form/invite-parent2", { mode: "member" });
      queryClient.invalidateQueries({ queryKey: ["/api/ip-form"] });
      toast({ title: "Invitation sent", description: `${name || email} received login details by email - the form will be waiting on their home page.` });
      setMode(null);
    } catch (e: any) {
      toast({ title: "Could not invite", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const inviteGuest = async () => {
    setBusy(true);
    try {
      const res = await apiRequest("POST", "/api/ip-form/invite-parent2", { mode: "guest", email: email.trim(), name: name.trim() });
      const body = await res.json();
      setGuestLink(body.link || null);
      queryClient.invalidateQueries({ queryKey: ["/api/ip-form"] });
      toast({ title: "Signing link sent", description: `${name || email} got a private link by email to fill their sections and sign.` });
    } catch (e: any) {
      toast({ title: "Could not send link", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 pt-1" data-testid="ipform-invite-panel">
      <p className="text-sm text-muted-foreground">
        Your partner needs to complete their sections and sign. How would they like to do it?
      </p>
      {data.guestInvite && !guestLink && (
        <p className="text-xs text-muted-foreground">
          A signing link was already sent to {data.guestInvite.email} (expires {new Date(data.guestInvite.expiresAt).toLocaleDateString()}). Sending a new one replaces it.
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setMode(mode === "member" ? null : "member")}
          className={`text-left rounded-[var(--radius)] border p-3 transition-colors ${mode === "member" ? "border-primary bg-secondary/50" : "border-border hover:border-primary/50"}`}
          data-testid="ipform-invite-member"
        >
          <p className="font-medium text-sm flex items-center gap-1.5"><UserPlus className="w-4 h-4 text-primary" /> Create an account for them</p>
          <p className="text-xs text-muted-foreground mt-1">They get their own GoStork login, see the form as a task, and can use everything on the account.</p>
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "guest" ? null : "guest")}
          className={`text-left rounded-[var(--radius)] border p-3 transition-colors ${mode === "guest" ? "border-primary bg-secondary/50" : "border-border hover:border-primary/50"}`}
          data-testid="ipform-invite-guest"
        >
          <p className="font-medium text-sm flex items-center gap-1.5"><Link2 className="w-4 h-4 text-primary" /> Send a signing link</p>
          <p className="text-xs text-muted-foreground mt-1">No account needed - they open a private email link, fill their sections, and sign. Expires in 30 days.</p>
        </button>
      </div>

      {mode && (
        <div className="space-y-3 rounded-[var(--radius)] bg-secondary/40 p-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Their name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Partner's name" data-testid="ipform-invite-name" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Their email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partner@email.com" data-testid="ipform-invite-email" />
            </div>
          </div>
          {mode === "member" && hasMember2 && (
            <p className="text-xs text-muted-foreground">Your partner already has an account on this journey - this just reminds them about the form.</p>
          )}
          <Button
            type="button"
            disabled={busy || (!(mode === "member" && hasMember2) && !/^\S+@\S+\.\S+$/.test(email))}
            onClick={mode === "member" ? inviteMember : inviteGuest}
            data-testid="ipform-invite-send"
          >
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mail className="w-4 h-4 mr-2" />}
            {mode === "member" ? (hasMember2 ? "Send reminder" : "Create account and invite") : "Email the signing link"}
          </Button>
          {guestLink && (
            <div className="flex items-center gap-2">
              <Input readOnly value={guestLink} className="text-xs" data-testid="ipform-guest-link" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(guestLink);
                  toast({ title: "Link copied" });
                }}
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
