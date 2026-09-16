/**
 * "So far" strip under the concierge header.
 *
 * Restates what Eva has actually SAVED about the family, folded to one line
 * by default and opening inline (no modal). It reads the same profile and
 * user rows Eva reads, so it can never show something she does not know,
 * and it refreshes as she saves. There are no edit controls on purpose:
 * free text already corrects any answer, and the hint says so.
 *
 * For an invited member it adds one line naming whose account they joined,
 * which is the catch-up a partner opening a transcript addressed to someone
 * else was missing.
 *
 * Parent-private: rendered only on Eva's own session, never a provider one.
 */
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";

type Fact = { key: string; label: string; value: string; pending?: boolean };

const FAMILY_LABEL: Record<string, string> = {
  solo_man: "Solo dad",
  solo_woman: "Solo mom",
  two_dads: "Two dads",
  two_moms: "Two moms",
  straight_couple: "Couple",
};

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function ageFrom(dob: string | Date | null | undefined): number | null {
  if (!dob) return null;
  const y = new Date(dob).getFullYear();
  if (!y || isNaN(y)) return null;
  const age = new Date().getFullYear() - y;
  return age >= 18 && age <= 80 ? age : null;
}

const EGG_LABEL: Record<string, string> = { "egg donor": "Donor eggs", "donor eggs": "Donor eggs", "partner eggs": "Partner's eggs", "own eggs": "Own eggs", "self": "Own eggs" };

/**
 * A scripted answer Eva has just heard but not yet saved. Keyed on the
 * question that preceded it so a shared chip like "No preference" lands on
 * the right fact. Cleared automatically once the profile poll carries it.
 */
function pendingFactFrom(question: string, answer: string): Fact | null {
  const q = question.toLowerCase();
  const a = answer.trim();
  if (!q || !a || a.length > 60) return null;
  if (/termination/.test(q)) return { key: "termination", label: "Termination", value: a, pending: true };
  if (/hoping (for|to have) twins/.test(q)) return { key: "twins", label: "Twins", value: a, pending: true };
  if (/first ivf journey/.test(q)) return { key: "firstIvf", label: "IVF history", value: a, pending: true };
  if (/most important to you when choosing a clinic/.test(q)) return { key: "priority", label: "Priority", value: a, pending: true };
  if (/how old are you/.test(q)) return { key: "ages", label: "Age", value: a, pending: true };
  if (/how old is your partner/.test(q)) return { key: "partnerAge", label: "Partner age", value: a, pending: true };
  if (/who is planning to carry|carrying the pregnancy/.test(q)) return { key: "carrier", label: "Carrier", value: a, pending: true };
  if (/plan for eggs|were the eggs/.test(q)) return { key: "eggs", label: "Eggs", value: a, pending: true };
  if (/sperm/.test(q) && /own|partner|donor/.test(q)) return { key: "sperm", label: "Sperm", value: a, pending: true };
  if (/which countr|surrogacy in/.test(q)) return { key: "countries", label: "Countries", value: a, pending: true };
  return null;
}

export function WhatIKnowStrip({ conciergeName, lastExchange }: { conciergeName?: string | null; lastExchange?: { question: string; answer: string } | null }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const u = user as any;

  const { data: profile } = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!user,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const isMember = !!u?.parentAccountRole && u.parentAccountRole !== "INTENDED_PARENT_1";
  const { data: members } = useQuery<{ id: string; name?: string | null; parentAccountRole?: string | null }[]>({
    queryKey: ["/api/parent-account/members"],
    enabled: !!user && isMember,
    staleTime: 60_000,
  });
  const ownerFirstName = (Array.isArray(members) ? members : [])
    .find(m => m.parentAccountRole === "INTENDED_PARENT_1")?.name?.split(" ")[0] || null;

  const p = profile || {};
  const facts: Fact[] = [];

  // familyType lives on the profile; older sessions saved only gender,
  // relationship and orientation on the user row, so derive from those too.
  const gender = String(u?.gender || "").toLowerCase();
  const rel = String(u?.relationshipStatus || "").toLowerCase();
  const orient = String(u?.sexualOrientation || "").toLowerCase();
  const isMan = /\bman\b|male/.test(gender) && !/woman|female/.test(gender);
  const isWoman = /woman|female/.test(gender);
  const single = /single|solo/.test(rel);
  const derivedFamily = !p.familyType && (isMan || isWoman)
    ? (single ? (isMan ? "Solo dad" : "Solo mom")
      : rel ? (isMan && orient === "gay" ? "Two dads" : isWoman && orient === "lesbian" ? "Two moms" : "Couple") : null)
    : null;
  const family = p.familyType ? FAMILY_LABEL[p.familyType] || titleCase(String(p.familyType)) : derivedFamily;
  if (family) facts.push({ key: "family", label: "Family", value: family });

  // "New York, New York" reads as a stutter; one name when city and state match.
  const home = [u?.city, u?.state].filter(Boolean).filter((v, i, arr) => i === 0 || String(v).trim().toLowerCase() !== String(arr[0]).trim().toLowerCase()).join(", ");
  if (home) facts.push({ key: "home", label: "Home", value: home });

  // An explicit "no" (the parent deselected it) beats the onboarding list.
  const services: string[] = [];
  const wants = (flag: boolean | null | undefined, svc: string) => flag === true || (flag !== false && (p.interestedServices || []).includes(svc));
  if (wants(p.needsClinic, "Fertility Clinic")) services.push("IVF clinic");
  if (wants(p.needsEggDonor, "Egg Donor")) services.push("egg donor");
  if (wants(p.needsSpermDonor, "Sperm Donor")) services.push("sperm donor");
  if (wants(p.needsSurrogate, "Surrogate")) services.push("surrogate");
  if (services.length) {
    const list = services.length > 1 ? services.slice(0, -1).join(", ") + " and " + services[services.length - 1] : services[0];
    facts.push({ key: "services", label: "Looking for", value: list.charAt(0).toUpperCase() + list.slice(1) });
  }

  if (p.hasEmbryos === true) facts.push({ key: "embryos", label: "Embryos", value: p.embryoCount ? `${p.embryoCount} frozen` : "Yes, frozen" });
  else if (p.hasEmbryos === false) facts.push({ key: "embryos", label: "Embryos", value: "None yet" });

  const age = ageFrom(u?.dateOfBirth);
  const partnerAge = typeof u?.partnerAge === "number" && u.partnerAge >= 18 ? u.partnerAge : null;
  if (age && partnerAge) facts.push({ key: "ages", label: "Ages", value: `${age} and ${partnerAge}` });
  else if (age) facts.push({ key: "ages", label: "Age", value: String(age) });

  if (p.eggSource) facts.push({ key: "eggs", label: "Eggs", value: EGG_LABEL[String(p.eggSource).toLowerCase()] || titleCase(String(p.eggSource)) });
  if (p.spermSource) facts.push({ key: "sperm", label: "Sperm", value: titleCase(String(p.spermSource)) });
  if (p.carrier) facts.push({ key: "carrier", label: "Carrier", value: titleCase(String(p.carrier)) });
  if (p.surrogateCountries) facts.push({ key: "countries", label: "Countries", value: String(p.surrogateCountries) });
  if (p.surrogateTermination) facts.push({ key: "termination", label: "Termination", value: String(p.surrogateTermination) });
  if (p.surrogateTwins) facts.push({ key: "twins", label: "Twins", value: /^yes$/i.test(String(p.surrogateTwins)) ? "Hoping for twins" : /^no$/i.test(String(p.surrogateTwins)) ? "Singleton" : titleCase(String(p.surrogateTwins)) });
  if (p.isFirstIvf === true) facts.push({ key: "firstIvf", label: "IVF history", value: "First time" });
  else if (p.isFirstIvf === false) facts.push({ key: "firstIvf", label: "IVF history", value: "Done IVF before" });
  if (p.clinicPriority) facts.push({ key: "priority", label: "Priority", value: String(p.clinicPriority) });

  // Heard but not yet saved: show it now, in italics, until the poll confirms.
  const pending = lastExchange ? pendingFactFrom(lastExchange.question, lastExchange.answer) : null;
  if (pending && !facts.some(f => f.key === pending.key)) facts.push(pending);

  // Nothing worth restating yet: stay out of the way until Eva has learned
  // at least two things.
  if (facts.length < 2 && !isMember) return null;

  // Labelled pairs, most recently learned first: the fold shows ~36 chars on
  // a phone, so the newest facts (what Eva just heard) must lead.
  const line = [...facts].reverse().map(f => `${f.label} ${f.value}`).join(" · ");
  const who = conciergeName || "your concierge";

  return (
    <div
      className="mx-3 mt-1 mb-2 border border-border bg-secondary px-3.5 py-2.5"
      style={{ borderRadius: "var(--chat-bubble-radius, 20px)" }}
      data-testid="what-i-know-strip"
    >
      {/* The whole row toggles (44px tall on touch): the old 34x20 grey
          "Show" was the only way to see what Eva has saved, and it rendered
          in helper grey because the .t-helper colour beat the utility. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="what-i-know-facts"
        className="w-full flex items-center gap-2.5 text-left -my-1 py-1 min-h-11 md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
        data-testid="what-i-know-toggle"
      >
        <span className="t-micro-label whitespace-nowrap">So far</span>
        <span className="t-helper text-foreground min-w-0 flex-1 truncate" data-testid="what-i-know-line">
          {line || "Getting to know you"}
        </span>
        <span className="t-helper font-ui font-medium whitespace-nowrap" style={{ color: "hsl(var(--primary))" }} aria-hidden="true">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {isMember && (
        <p className="mt-2 flex items-center gap-2 t-helper text-foreground" data-testid="what-i-know-member">
          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "hsl(var(--brand-success))" }} aria-hidden="true" />
          {ownerFirstName ? `You're on ${ownerFirstName}'s account. Everything here is shared with you both.` : "You're on your family's account. Everything here is shared with you both."}
        </p>
      )}

      {/* Label column sizes to its longest label so "Looking for" never
          wraps; values sit on the transcript's own scale (micro value =
          15px), not the profile page's 17px field value, so the strip
          reads as part of the chat rather than a form dropped into it. */}
      {open && (
        <div id="what-i-know-facts" className="mt-2.5 pt-2.5 border-t border-border grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-baseline max-h-[38dvh] overflow-y-auto scroll-fade-bottom">
          {facts.map(f => (
            <Fragment key={f.key}>
              <span className="t-micro-label whitespace-nowrap">{f.label}</span>
              <span className={`t-micro-value ${f.pending ? "italic text-muted-foreground" : ""}`} data-testid={`what-i-know-${f.key}`}>{f.value}</span>
            </Fragment>
          ))}
          <p className="t-helper pt-1 col-span-2">
            Something off? <span className="font-medium text-foreground">Just tell {who}</span> and it gets fixed.
          </p>
        </div>
      )}
    </div>
  );
}
