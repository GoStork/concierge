# Donor Biometric Consent - Draft Terms (Look-Alike Face Matching)

> **NOT LEGAL ADVICE.** Engineering-authored template describing how the feature
> works and the consent model, so qualified legal counsel can draft the binding
> language. Biometric privacy laws vary (Illinois BIPA 740 ILCS 14, Texas CUBI,
> Washington HB 1493, EU GDPR Art. 9). Counsel must review and adapt to every
> jurisdiction where donors/surrogates reside before launch.

## 1. What the feature does

GoStork offers intended parents an optional "find someone who looks like me"
search. When a parent uploads their own photo in the AI concierge, GoStork
creates a faceprint (a numerical face-geometry vector) from the donor/surrogate
profile photos already on file and compares it, surfacing visually similar
profiles. The comparison uses **AWS Rekognition** as a processor; faceprints are
stored in an AWS face collection.

## 2. The consent model: agency-mediated (this is the key point)

**GoStork has no direct relationship with donors or surrogates** - they are
recruited and onboarded by the **agencies** (providers) that list them on the
marketplace. GoStork cannot obtain consent from donors directly (donors have no
GoStork account). Therefore:

- **The agency is responsible for obtaining biometric consent** from its donors
  and surrogates, as part of its own intake/onboarding (where it already obtains
  consent to list their photos on marketplaces like GoStork).
- **GoStork's obligation** (because it generates and stores the faceprints) is
  handled through: (a) a contractual representation/warranty from the agency,
  (b) a per-agency authorization gate in the product, and (c) GoStork's own
  public biometric retention/destruction policy (Section 5).

### 2a. Provider/agency agreement clause (GoStork <-> agency)

> **Biometric Authorization.** Agency represents and warrants that it has
> obtained from each donor and surrogate it lists all consents and authorizations
> required by applicable law (including any written release required under
> biometric privacy statutes) for GoStork and its service providers (including
> Amazon Web Services) to create, store, and use a faceprint derived from that
> individual's profile photographs for the sole purpose of look-alike matching on
> the GoStork platform. Agency will not enable biometric matching for any
> individual who has not provided such consent, and will promptly disable it for
> any individual who withdraws consent. Agency shall indemnify GoStork against
> claims arising from Agency's failure to obtain or maintain such consents.

### 2b. Suggested donor/surrogate intake clause (agency -> its donor)

> I authorize [Agency] and its marketplace partners (including GoStork and its
> processors) to create and store a faceprint from my photographs solely to help
> intended parents find donors/surrogates who resemble them. This is used only for
> resemblance matching, is never sold, and I may withdraw it at any time by
> contacting [Agency], after which my faceprint will be deleted.

## 3. Product enforcement (built)

- **Per-agency authorization flag** `Provider.biometricMatchingAuthorized`
  (default **false**). An agency enables it from its **Company** settings tab
  (a card shown only to agencies with donor/surrogate services); GoStork admins
  can also set it on the admin provider-edit page. `biometricMatchingAuthorizedAt`
  records when.
- **Indexing is gated on it**: `indexEntityFaces` and the backfill only index an
  agency's faces when the flag is true. Flipping it on indexes that agency's
  donors; flipping it off deletes their faceprints (`applyProviderFaceAuthorization`
  in `profile-sync.service.ts`).
- **Search is gated too** (defense in depth): `find_lookalike_matches` only
  returns donors whose agency currently has the flag on.

## 4. Disclosure to third parties

Faceprints are disclosed only to AWS (Amazon Rekognition) as a processor under
contract, solely to provide the matching service. No other third-party
disclosure except as required by law.

## 5. Retention and destruction schedule (GoStork's own, must be public)

Because GoStork holds the faceprints, it maintains a written, public retention
policy. A faceprint is permanently deleted from the AWS collection at the
**earliest** of:
- the agency disables biometric authorization, or removes/deactivates/hides the
  profile;
- GoStork is notified the individual withdrew consent;
- **3 years** after the profile's last activity; or
- the matching feature is discontinued.

(Counsel to confirm "3 years" against BIPA's default and any stricter limits.)

## 6. Withdrawal / deletion (implemented)

- Per-entity faceprints are tracked in `rekognitionFaceIds`; `deleteEntityFaces`
  removes them from AWS and clears `faceIndexedAt`.
- An agency disabling its authorization flag triggers bulk deletion of all its
  donors'/surrogates' faceprints automatically.
- **TODO:** a per-donor withdrawal path (agency-initiated removal of a single
  donor before the whole-agency toggle) and deletion on individual profile
  deactivation.

## 7. Parent side (implemented)

Parents who upload their own photo are gated by an in-chat consent step
(`IntendedParentProfile.faceMatchConsentAt`); the AI explains the biometric
processing and records explicit consent before any search. The parent's photo is
matched per-request and is NOT added to the searchable collection.

## 8. Open items for counsel

1. Confirm the agency representation/warranty + indemnity satisfies BIPA's
   "written release obtained by..." requirement, or whether GoStork needs the
   donor's release on file directly.
2. Confirm AWS data-processing terms cover biometric data for your use.
3. Publish GoStork's retention/destruction policy; confirm the 3-year period.
4. Decide messaging to agencies about re-consenting existing donors before they
   flip the authorization on.
5. Cross-border donors/surrogates (GDPR Art. 9 explicit consent).
