import { Check, X } from "lucide-react";

import { getMatchedPreferences, type SwipeDeckProfile, type UserPreference } from "@/components/marketplace/swipe-mappers";
import { formatFieldLabel } from "@/lib/format-label";
import { AttributeChip, ChipRow } from "@/components/ui/field";

/**
 * Why this person suits THIS parent.
 *
 * "Why This Match" only ever rendered when a parent arrived from Eva, so on the
 * marketplace, a shared link or the Saved tab every reader saw an identical
 * page - even though we know their journey, their IVF context and their
 * filters. That turns a recommendation back into a directory entry.
 *
 * Misses are shown too, capped at two. A parent who discovers the mismatch
 * after a consultation feels misled by the page; one who reads it here trusts
 * the next thing the page tells them.
 */

/** Human noun for a preference key, for the "doesn't match" half. */
const PREF_NOUN: Record<string, string> = {
  age: "age range",
  location: "location",
  ethnicity: "ethnicity",
  race: "race",
  religion: "religion",
  education: "education",
  hairColor: "hair colour",
  eyeColor: "eye colour",
  height: "height",
  bmi: "BMI",
  donorCompensation: "budget",
  baseCompensation: "budget",
  maxCost: "budget",
  agreesToTwins: "twins",
  covidVaccinated: "vaccination",
  relationshipStatus: "relationship status",
  occupation: "occupation",
};

function prefNoun(key: string): string {
  return PREF_NOUN[key] || formatFieldLabel(key).toLowerCase();
}

export function ProfileFitLine({
  profile,
  preferences,
  className,
}: {
  profile: SwipeDeckProfile | null | undefined;
  preferences: UserPreference[];
  className?: string;
}) {
  if (!profile) return null;

  const keys = Array.from(new Set(preferences.map((p) => p.key)));
  if (keys.length === 0) return null;

  const matched = getMatchedPreferences(profile, preferences);
  const matchedKeys = new Set(matched.map((m) => m.key));
  const missedKeys = keys.filter((k) => !matchedKeys.has(k));

  // Nothing matched and nothing to say: stay quiet rather than lead with a
  // negative on someone's profile.
  if (matched.length === 0) return null;

  const shownMatches = matched.slice(0, 4);
  const shownMisses = missedKeys.slice(0, 2);

  return (
    <div className={className} data-testid="profile-fit-line">
      <p className="t-field-label" data-testid="fit-summary">
        Matches {matched.length} of your {keys.length} {keys.length === 1 ? "preference" : "preferences"}
      </p>
      <ChipRow className="mt-1.5">
        {shownMatches.map((m) => (
          <AttributeChip key={m.key} icon={Check} data-testid={`fit-match-${m.key}`}>
            {m.displayLabel}
          </AttributeChip>
        ))}
        {matched.length > shownMatches.length && (
          <span className="t-helper self-center">+{matched.length - shownMatches.length} more</span>
        )}
      </ChipRow>
      {shownMisses.length > 0 && (
        <p className="t-helper mt-1.5 flex items-center gap-1.5" data-testid="fit-misses">
          <X className="w-3.5 h-3.5 shrink-0" />
          <span>
            Doesn't match your {shownMisses.map(prefNoun).join(" or ")}
            {missedKeys.length > shownMisses.length ? `, +${missedKeys.length - shownMisses.length} more` : ""}
          </span>
        </p>
      )}
    </div>
  );
}
