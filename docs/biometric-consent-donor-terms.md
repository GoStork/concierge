# Donor Biometric Consent - Draft Terms (Look-Alike Face Matching)

> **NOT LEGAL ADVICE.** This is an engineering-authored template describing how
> the look-alike face matching feature works, so that qualified legal counsel
> can draft the binding language. Biometric privacy laws vary by state and
> country (notably Illinois BIPA 740 ILCS 14, Texas CUBI, Washington HB 1493,
> and the EU GDPR Art. 9 special-category data). Counsel must review, adapt to
> every jurisdiction where donors reside, and confirm the retention schedule and
> consent mechanics before launch.

## 1. What the feature does (plain-English description for counsel)

GoStork offers intended parents an optional "find someone who looks like me"
search. When a parent uploads their own photo in the AI concierge chat, the
system compares the facial features in that photo against the photos already on
file for egg donors, sperm donors, and surrogates, and surfaces profiles that
visually resemble the parent.

To do this, GoStork creates a mathematical representation ("face vector" or
"faceprint") of the face in each donor/surrogate profile photo and stores it in
a search index. The comparison uses **Amazon Web Services (AWS) Rekognition** as
a third-party processor; the face vectors are stored in an AWS face collection.
GoStork does not use these faceprints for identity verification, surveillance,
law enforcement, advertising, or any purpose other than this resemblance search.

## 2. Biometric identifier defined

For these terms, a "biometric identifier" / "biometric information" means the
faceprint (the numerical face-geometry vector) derived from a donor's or
surrogate's profile photograph(s). The underlying photographs are governed by
GoStork's general privacy policy; this addendum governs the **faceprint derived
from** them.

## 3. Consent clause (donor-facing, for the agreement / onboarding checkbox)

> **Biometric Consent for Look-Alike Matching.** I understand and agree that
> GoStork (and its service provider Amazon Web Services) may create, collect, and
> store a faceprint - a mathematical representation of the facial features in my
> profile photo(s) - solely to power an optional feature that helps intended
> parents find donors or surrogates who visually resemble them. I understand
> that:
> - this faceprint is created only from photos I have already provided for my
>   GoStork profile;
> - it is used only for resemblance matching within GoStork, and is never sold,
>   leased, traded, or otherwise profited from;
> - it is not used for identity verification, surveillance, or any unrelated
>   purpose;
> - it is stored securely and retained per the schedule below, and permanently
>   deleted when I leave the platform or withdraw this consent;
> - I may withdraw this consent at any time, after which my faceprint will be
>   deleted and I will be excluded from look-alike search results, without
>   affecting my participation in GoStork in any other way.
>
> ☐ I consent to the creation and use of my faceprint for look-alike matching as
> described above. (Optional - you can decline and still use all other GoStork
> features.)

Note for counsel: BIPA requires **written informed consent obtained before
collection**. If any donor photos are already on file, faceprints must not be
generated for those donors until this consent is captured (or counsel confirms a
lawful basis). The build supports this: a donor with no recorded consent can be
excluded from indexing.

## 4. Disclosure to third parties

GoStork discloses faceprints only to AWS (Amazon Rekognition) acting as a data
processor under contract, strictly to provide the matching service. GoStork will
not disclose faceprints to any other third party except as required by law or
with separate consent.

## 5. Retention and destruction schedule (BIPA requires this to be written and public)

GoStork retains a donor/surrogate faceprint until the **earliest** of:
- the donor/surrogate withdraws biometric consent;
- the donor/surrogate profile is removed, deactivated, or hidden from the
  marketplace;
- **3 years** after the donor's/surrogate's last activity on the platform; or
- the initial purpose for collection (look-alike matching) is satisfied or
  discontinued.

On any of these triggers, the faceprint is permanently deleted from the AWS face
collection. (Counsel should confirm "3 years" against BIPA's "3 years after last
interaction" default and any stricter state limits.)

## 6. How withdrawal / deletion is implemented (engineering note)

Deletion is reversible and per-entity:
- Each donor/surrogate row stores its AWS face IDs in `rekognitionFaceIds`.
- `deleteEntityFaces()` in `server/src/modules/face/face-recognition.service.ts`
  removes those faces from the AWS collection.
- Clearing `faceIndexedAt` excludes the entity from future indexing.

A withdrawal action (or profile deactivation) should call `deleteEntityFaces()`
and clear the indexing columns. **TODO before launch:** wire a donor-facing
"withdraw biometric consent" control and a deletion hook on profile
deactivation. (Currently indexing happens on profile sync; the matching deletion
path exists but is not yet triggered by a consent-withdrawal UI.)

## 7. Parent side (already implemented, for completeness)

Intended parents who upload their own photo for matching are gated by an in-chat
consent step (`faceMatchConsentAt` on `IntendedParentProfile`); the AI explains
the biometric processing and records explicit consent before any search runs.
The parent's uploaded photo is matched per-request and is not added to the
searchable face collection.

## 8. Open items for counsel

1. Confirm the consent mechanism (checkbox vs signed agreement clause) satisfies
   "written release" under BIPA for every relevant state.
2. Confirm the AWS data-processing terms / BAA-equivalent cover biometric data.
3. Confirm the retention period and add the destruction policy to the public
   privacy policy.
4. Decide whether existing donors must be re-consented before back-indexing, or
   excluded until they consent.
5. Confirm cross-border handling if any donors/surrogates are outside the US
   (GDPR Art. 9 explicit consent).
