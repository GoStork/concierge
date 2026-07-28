# Comparing clinics and doctors

**Status: specified, not built.** Decisions are Eran's, 28 Jul 2026.

The donor/surrogate comparison exists (`compare-drawer.tsx`, PX-10, PX-15).
Clinics and doctors need the same affordance, but not the same rows - nobody
chooses a clinic on eye colour.

## Clinics

All four groups, in this order. Cost and access disqualify fastest; scale is
context.

**1. Outcomes**
- Live-birth rate **for this parent** - her egg source and age band, not the
  headline rate, which answers a question no individual parent is asking. The
  clinic profile already computes this; reuse it rather than recomputing.
- National average alongside, and `describeRateDelta` for the wording - below
  national is stated plainly, never in alarm red (see lib/rate-delta).

**2. Cost**
- Program total range per clinic.
- What each big-ticket item does or does not include: monitoring, anaesthesia,
  genetic testing, medication. Two clinics quoting the same number can differ by
  $20k once you read what it covers - `splitSharedItems` already computes
  included-vs-not and should be the source.

**3. Access**
- Location, accepting new patients, insurers accepted.

**4. Scale and services**
- CDC annual cycle volume, services offered (donor egg / gestational carrier /
  PGT), year founded, number of physicians.

## Doctors

**1. Their clinic, and that clinic's rate for this parent.** CDC reports at
clinic level, not physician level - so "how good is this doctor" honestly
answers as "here is their clinic and its outcomes". Do not imply a
physician-level statistic we do not have.

**2. Specialties matched to her diagnosis.** Which of the parent's own
diagnoses (IntendedParentProfile.diagnoses, already populated from the CDC
pipeline) each doctor lists a specialty in. Same idea as the donor fit line:
it answers "why this one, for me" rather than listing credentials.

**3. Access.** Location, accepting new patients, languages spoken - languages
matter more than they look for a relationship measured in months.

**4. Credentials.** Medical school, residency, ABOG/REI board certification,
years practising. Expect most of these rows to dim as identical across a
shortlist, which is the correct outcome - the comparison shows they do not
differentiate rather than hiding them.

## When the parent has no profile yet

Show the rate rows using the all-patients figure, **labelled as such**, with a
one-line prompt to add her age and egg source for her own numbers.

Not hidden: a comparison missing its most important row looks broken. Not shown
bare either: a parent must never compare two clinics on figures describing a
population she is not in. The prompt sits where the motivation actually is -
she is looking at the number she wants personalised.

## Build notes

- `CompareKind` grows `"clinic" | "doctor"`. `buildCompareTable` already returns
  ordered groups with empty-row dropping and identical-row dimming - both apply
  unchanged.
- The Saved view wires compare per tab; today `compareKind` is null for the
  clinic and doctor tabs (marketplace-page). That gate is where it turns on.
- Reuse, do not re-derive: `getMandatoryFields` has no clinic/doctor equivalent,
  so these row builders are new - but the rate must come from the same
  computation as the clinic profile, and the cost split from
  `splitSharedItems`. Two sources for one number is how the donor comparison
  ended up omitting half the Summary.
- PX-10 covers donor/surrogate; clinics and doctors want their own case,
  including "no parent profile shows the all-patients rate, labelled".
