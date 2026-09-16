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

export function WhatIKnowStrip({ conciergeName }: { conciergeName?: string | null }) {
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

  const home = [u?.city, u?.state].filter(Boolean).join(", ");
  if (home) facts.push({ key: "home", label: "Home", value: home });

  const services: string[] = [];
  if (p.needsClinic === true || (p.interestedServices || []).includes("Fertility Clinic")) services.push("IVF clinic");
  if (p.needsEggDonor === true || (p.interestedServices || []).includes("Egg Donor")) services.push("egg donor");
  if (p.needsSpermDonor === true || (p.interestedServices || []).includes("Sperm Donor")) services.push("sperm donor");
  if (p.needsSurrogate === true || (p.interestedServices || []).includes("Surrogate")) services.push("surrogate");
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

  if (p.eggSource) facts.push({ key: "eggs", label: "Eggs", value: titleCase(String(p.eggSource)) });
  if (p.spermSource) facts.push({ key: "sperm", label: "Sperm", value: titleCase(String(p.spermSource)) });
  if (p.carrier) facts.push({ key: "carrier", label: "Carrier", value: titleCase(String(p.carrier)) });
  if (p.surrogateCountries) facts.push({ key: "countries", label: "Countries", value: String(p.surrogateCountries) });

  // Nothing worth restating yet: stay out of the way until Eva has learned
  // at least two things.
  if (facts.length < 2 && !isMember) return null;

  const line = facts.map(f => f.value).join(" · ");
  const who = conciergeName || "your concierge";

  return (
    <div
      className="mx-3 mt-1 mb-2 border border-border bg-secondary px-3.5 py-2.5"
      style={{ borderRadius: "var(--chat-bubble-radius, 20px)" }}
      data-testid="what-i-know-strip"
    >
      <div className="flex items-center gap-2.5">
        <span className="t-micro-label whitespace-nowrap">So far</span>
        <span className="t-helper text-foreground min-w-0 flex-1 truncate" data-testid="what-i-know-line">
          {line || "Getting to know you"}
        </span>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-controls="what-i-know-facts"
          className="t-helper text-primary font-ui whitespace-nowrap hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          data-testid="what-i-know-toggle"
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

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
        <div id="what-i-know-facts" className="mt-2.5 pt-2.5 border-t border-border grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-baseline">
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
