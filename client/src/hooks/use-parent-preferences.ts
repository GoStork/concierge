import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppSelector } from "@/store";
import type { UserPreference } from "@/components/marketplace/swipe-mappers";

/**
 * What this parent is looking for, as preferences the matcher understands.
 *
 * Two sources, in priority order:
 *   1. Filters they set in the marketplace right now (activeFilters).
 *   2. What onboarding and Eva already learned - donor traits, egg source, IVF
 *      context - from /api/parent-profile.
 *
 * The fallback matters more than it sounds: filters are cleared whenever the
 * parent switches profile type, and never exist at all on a shared link or in
 * the Saved tab. Without it a fit line would be blank for most readers, which
 * is precisely when a profile most needs to explain itself.
 *
 * A marketplace filter always wins over the stored profile - it is the more
 * recent, more deliberate statement of intent.
 */

const RANGE_KEYS = new Set([
  "age", "bmi", "height", "donorCompensation", "maxCost", "baseCompensation",
  "maxLiveBirths", "maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear",
]);

/** activeFilters -> UserPreference[]. Mirrors the marketplace's own derivation. */
export function preferencesFromFilters(activeFilters: Record<string, string[]>): UserPreference[] {
  const prefs: UserPreference[] = [];
  for (const [key, vals] of Object.entries(activeFilters || {})) {
    if (!vals || vals.length === 0) continue;
    if (RANGE_KEYS.has(key)) {
      if (vals.length === 2) prefs.push({ key, value: "range", rangeMin: Number(vals[0]), rangeMax: Number(vals[1]) });
      continue;
    }
    if (key === "agreesToTwins" || key === "covidVaccinated") { prefs.push({ key, value: true }); continue; }
    for (const v of vals) prefs.push({ key, value: v });
  }
  return prefs;
}

/** The stored intended-parent profile -> the same preference shape. */
export function preferencesFromParentProfile(profile: any): UserPreference[] {
  if (!profile) return [];
  const prefs: UserPreference[] = [];
  const add = (key: string, value: unknown) => {
    if (value == null) return;
    const s = String(value).trim();
    // "Any" / "No preference" are answers meaning the parent is open, not a filter.
    if (!s || /^(any|no preference|open|doesn'?t matter|not sure)$/i.test(s)) return;
    // A stored answer can be a comma list ("Blue, Green").
    for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
      prefs.push({ key, value: part });
    }
  };
  add("eyeColor", profile.donorEyeColor);
  add("hairColor", profile.donorHairColor);
  add("height", profile.donorHeight);
  add("education", profile.donorEducation);
  add("ethnicity", profile.donorEthnicity);
  return prefs;
}

export function useParentPreferences(): { preferences: UserPreference[]; isLoading: boolean } {
  const activeFilters = useAppSelector((s) => s.ui.activeFilters);

  const { data: parentProfile, isLoading } = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const preferences = useMemo(() => {
    const fromFilters = preferencesFromFilters(activeFilters);
    const filterKeys = new Set(fromFilters.map((p) => p.key));
    // Stored answers fill only the gaps a live filter hasn't already spoken to.
    const fromProfile = preferencesFromParentProfile(parentProfile).filter((p) => !filterKeys.has(p.key));
    return [...fromFilters, ...fromProfile];
  }, [activeFilters, parentProfile]);

  return { preferences, isLoading };
}
