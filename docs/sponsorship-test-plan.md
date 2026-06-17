# Profile Sponsorship — Test Plan

Providers pay GoStork monthly to boost their profiles in the marketplace
(badge + sort priority + AI concierge tiebreaker). Two products: **slot bundles**
(individual donors/surrogates/sperm donors/doctors) and **whole-profile** boosts
(the provider's own IVF clinic / surrogacy agency profile, priced per type).

## Setup
- **Accounts**: one **GoStork admin**; one **provider billing user**
  (`PROVIDER_ADMIN` or `BILLING_MANAGER`) for an egg-donor/surrogacy agency, and
  ideally one for an **IVF clinic** (to test whole-profile pricing).
- **Stripe test cards**: success `4242 4242 4242 4242`; decline `4000 0000 0000 0002`.
  Any future expiry, any CVC/ZIP.
- **Plans seeded** (verify on the page): Starter $199/5, Growth $599/25,
  Pro $1,499/100, IVF whole-profile **$5,000**, Surrogacy whole-profile **$2,500**.
- **Email checks**: have access to the billing user's inbox (lifecycle emails go to
  `PROVIDER_ADMIN` / `BILLING_MANAGER` users).
- **Before testing impressions**: hard-refresh the browser once (profile-view
  tracking fix is a client change) so views start recording.

---

## 1. Provider self-serve — one-time purchase
1. Provider → **`/account/sponsorship`** (a *separate* "Sponsorship" nav item,
   billing-gated — confirm it is **not** nested under the donor tabs).
2. Confirm KPI cards, plan cards, and (initially empty) history render.
3. Billing toggle → **One month** → **Sponsor** on **Starter** → inline Stripe form
   appears (no modal/popup) → pay with `4242…`.
4. **Expect**: sponsorship appears under "Your sponsorships" as **ACTIVE**, `0/5 slots`
   (activation is webhook-driven; may take a second).
5. **Email**: billing user receives a branded "Your sponsorship is active" email.

## 2. Provider self-serve — auto-renew
6. Billing toggle → **Auto-renew monthly** → **Sponsor** on **Growth** → pay → **ACTIVE**.
7. In Stripe, trigger the subscription's next cycle invoice → confirm `currentPeriodEnd`
   extends and **no second email** is sent (renewals are intentionally silent).

## 3. Slot management
8. Growth sponsorship → **Manage slots** → **Egg donors** → **+** two donors → they show
   as filled chips; counter reads `2/25`.
9. Remove one (the **×** on its chip) → counter drops, that donor's boost clears.
10. Fill a Starter (5) bundle to the cap → adding a 6th is blocked ("All slots filled").

## 4. Inline "Sponsor this" shortcut
11. Provider → **`/account/egg-donors`** (or admin → provider edit → Egg Donors tab).
    Each card has a **Sparkles** button.
12. Click it on a donor → toast "Profile sponsored" and the card shows a **SPONSORED**
    badge (added to your open bundle).
13. Remove all open slots, then click Sparkles again → routed to the Sponsorship tab
    with a "No open slot" toast.

## 5. Marketplace badge + sort + pinning + rotation
14. Marketplace **egg-donor** deck → sponsored donors are at the **top** with a mauve
    **Sponsored** chip.
15. Repeat for **surrogate** and **sperm-donor** decks (sponsor a couple first).
16. **Filter pinning**: apply **Cost: low→high** + some filters → sponsored profiles that
    pass the filter stay **pinned on top**.
17. **Rotation**: reload the deck several times across >30s → sponsored stay on top but
    their **internal order rotates** (no single agency permanently owns slot #1).

## 6. Admin — Comp (free grant)
18. Admin → provider edit page → **`?tab=sponsorship`** (a standalone top-level tab).
19. Pick a plan → **Comp** → activates **immediately** (no payment), shows a **Comped** badge.
20. Confirm the comped profiles boost in the marketplace and the provider gets an
    "active" email.

## 7. Admin — Charge / Send payment request
21. Admin on the same tab → set billing mode → **Charge** on a plan.
22. **Two things happen**: the admin sees an inline Stripe form (can take the card on a
    call), **and** the provider's billing contacts get a "Complete your sponsorship
    payment" email. The sponsorship shows **PENDING PAYMENT**.
23. As the **provider** → `/account/sponsorship` → the pending sponsorship shows a
    **"Complete payment"** button → click → inline Stripe checkout → pay → flips
    **ACTIVE** + "active" email.
24. (Alt) As the **admin**, complete the inline form on the call → also flips ACTIVE.

## 8. Whole-profile pricing (per provider type)
25. On an **IVF clinic** provider, the whole-profile plan reads **$5,000/mo**; on a
    **surrogacy agency**, **$2,500/mo**.
26. Sponsor the whole profile → the clinic/agency's own card carries the Sponsored badge
    and floats up in the clinic/agency marketplace deck.

## 9. Cancel
27. On an active auto-renew sub → **Cancel auto-renew** → `canceledAt` set,
    "(auto-renew off)" shown; boost **persists** until `currentPeriodEnd`.

## 10. Expiry scheduler
28. In the DB, set a one-time or comped sponsorship's `currentPeriodEnd` to the past.
29. Wait ≤10 min (or restart the server to trigger the boot sweep) → status flips
    **EXPIRED**, `sponsoredUntil` clears, the marketplace badge disappears, and the
    provider gets an "ended" email + in-app notification.
30. Abandoned-checkout: a `PENDING_PAYMENT` sponsorship older than 24h auto-flips to
    **CANCELED**.

## 11. Lifecycle emails — checklist
Confirm a branded email (brand colors/logo, "Manage Sponsorship" button) arrives for each:
- [ ] **Activated** (first activation only)
- [ ] **Payment requested** (admin Charge)
- [ ] **Payment failed / past due** (decline card `4000…0002` on a renewal, or fail a
      subscription invoice in Stripe)
- [ ] **Expired** and **Canceled**
- [ ] **No** email on a normal monthly renewal

## 12. AI concierge prioritization
31. In `/chat`, drive to a donor/surrogate recommendation where two candidates are
    **equally good** and one is sponsored.
32. **Expect**: the AI presents the **sponsored one first** via `[[MATCH_CARD]]`, never
    names sponsorship as the reason, and **never** surfaces a worse-fit profile just
    because it's sponsored (fit + Biological Master Logic still win).

## 13. Analytics dashboard
33. Both surfaces (admin `?tab=sponsorship`, provider `/account/sponsorship`) show: KPI
    cards, **Impressions over time** (line chart), **Engagement funnel**, **Sponsored
    profile performance** table, and **Sponsorship history**.
34. **Impressions**: after the hard-refresh, browse some sponsored profiles in the
    marketplace as a parent (view/expand cards) → return to the dashboard →
    impressions/per-profile counts increment. *(Only counts views **after** the tracking
    fix; pre-fix history is zero by design.)*
35. **Saves/Inquiries**: heart a sponsored donor and start a concierge whisper about its
    provider → Saves and Inquiries KPIs increment.
36. All metrics are **windowed to the active sponsorship period** (not all-time).

## 14. Edge cases
- [ ] **Downgrade over capacity**: move from Pro (100) to a tier below the number of
      filled slots → blocked with a prompt to remove profiles.
- [ ] **Double coverage**: sponsor the same donor via an admin comp **and** a provider
      bundle → removing one keeps the boost (latest period wins); removing both clears it.
- [ ] **Refund**: refund a one-time sponsorship charge in Stripe → the boost deactivates
      (status CANCELED).
- [ ] **Deleted/hidden entity**: hide a sponsored donor from search → it drops out of the
      marketplace; the slot shows as occupied by an inactive profile.
- [ ] **Multi-tenant isolation**: provider A cannot see/manage provider B's sponsorships
      (provider routes are scoped to the session's `providerId`).

---

## Quick smoke (5 min)
Provider buys Starter one-time → fills 2 donor slots → those donors top the marketplace
deck with the Sponsored badge → admin comps a plan for another provider → cancel one →
confirm "active" + "ended" emails arrive.

---

## Notes / known scope
- **Doctor inline shortcut** is intentionally **not** on the Team tab: that table lists
  `User` accounts, whose ids differ from the `ProviderMember` (doctor-profile) ids
  sponsorship targets. Doctors are sponsored via the Sponsorship tab's slot picker
  (correct ids).
- **Impressions** only accrue from views recorded after the profile-view tracking path
  fix; there is no backfill of historical impressions.
