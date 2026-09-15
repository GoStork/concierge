# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: Intended Parents.** People and couples trying to build a family through assisted reproduction - IVF, egg or sperm donation, surrogacy, or an international program. They arrive mid-journey, often after a loss or a failed cycle, carrying medical, financial, and emotional load at the same time. They are comparing clinics, agencies, banks, donors, and surrogates they have no expertise in, mostly on a phone, often at night. Their job is to find the right provider and match, understand what it will cost, and get a real conversation booked without being sold to.

When parent and provider needs conflict, design for the parent first. This was confirmed by the founder on 2026-09-15.

**Secondary: Providers.** Staff at IVF clinics, egg donor agencies, surrogacy agencies, egg banks, sperm banks, and fertility law firms. Coordinators, intake staff, and owners who work the inbox, lead queue, calendar, cost sheets, agreements, and payouts all day. Their job is to answer prospective parents fast, keep their donor and surrogate rosters current, and close matches. They get a work-tool experience.

**Tertiary: GoStork admins.** Internal staff who monitor Eva sessions, take over conversations, approve cost sheets, manage brand settings, and run the launch.

Shared parent accounts are real: partners and family members on the same account see the same conversations and get the same notifications.

## Product Purpose

GoStork is a fertility matching concierge. It connects Intended Parents with vetted fertility providers and, through Eva, an AI concierge, guides them from first question to a booked consultation, a chosen donor or surrogate, a signed agreement, and paid milestones. It exists because the fertility industry is fragmented, opaque on price, and exhausting to navigate alone. Success for a parent is a match and a plan they trust, reached with less time, less money, and less anxiety than doing it alone. Success for a provider is qualified, ready-to-talk families arriving in their inbox with the intake already done. Success for GoStork is completed matches and consultations, not page views.

GoStork 1.0 is live at app.gostork.com. This repository is GoStork 2.0, which replaces it.

## Positioning

GoStork is a personal matchmaker, not a marketplace. Copy and product framing must open positive and lead with guidance and matching, never with "compare prices like Kayak". The mechanism a neighbor cannot copy: one AI concierge (Eva) that holds the parent's full context across their whole journey, whispers anonymous questions to providers on the parent's behalf, reveals identity only when the parent commits to a call, and stays in the room as a three-way co-pilot once the provider joins. Parents never fill the same form twice, and providers never see a cold lead.

## Operating Context

- Parents live in a single unified conversations page (`/chat`) with Eva pinned at the top and each provider thread beneath it, plus a swipe-deck marketplace of donors, surrogates, clinics, and doctors, a calendar of booked calls, saved matches, documents, and payments.
- Providers live in the same conversations page in a master-detail inbox, plus a Home work queue, a parent CRM with per-service-line ownership, calendar and availability, cost sheets, agreements, reviews, payouts, and automation settings.
- The journey passes through real documents and rituals: the Intended Parent Form that gates a match call, provider cost sheets and quotes, PandaDoc-signed agreements, W-9 and provider agreements, installment payment schedules, Daily.co telehealth calls with consent-gated recording, and SMS/email notifications with carrier-registered consent wording.
- Donor and surrogate rosters come from nightly scrapes and API syncs of provider systems, with photos, so profile completeness varies by source.
- Both founder Macs are dev environments behind ngrok; production will be app.gostork.com.

## Capabilities and Constraints

- Six provider service lines: IVF Clinics, Egg Donor Agencies, Surrogacy Agencies, Egg Banks, Sperm Banks, Legal Services. International programs pair an agency with a partner clinic and need two consultation bookings.
- Eva runs on Gemini with a four-layer intake (bypasses, state machine, Tier 1, Tier 2) and structured tags that render interactive cards in chat. Any donor or surrogate recommendation must render a match card, never plain text.
- Marketplace visibility is gated by provider service approval and by ASRM surrogate minimums set on the GoStork house provider.
- Multi-tenant with strict tenant isolation. Provider data, knowledge bases, and RAG are scoped per organization.
- Stripe Connect handles provider payouts; history includes a 1.0 account-takeover breach, so payment surfaces carry extra guardrails.
- Terminology: "Intended Parents" or "parents", never "customers". "Providers" for the supply side. "Eva" or "AI Concierge" for the assistant. "Match Call" for the first parent-provider consultation. "Tasks" not "Next step".
- Signup order is a security decision, not a UX one: phone verification (OTP) happens BEFORE email and account creation. The 1.0 platform was abused by bots that created accounts with email first; the phone gate is the fraud control (see the SMS toll-fraud defences in the security memory). Do not propose "email first, phone later" as a UX improvement.
- Shared parent accounts are built by invitation from inside the app: an existing parent adds a partner or family member on the Invite Member page (`/users/new?parentAccount=true`) with a role of Intended Parent 2 (full access) or Viewer. Invited members receive a one-time set-password link (7 days), choose their own password, log in, and complete a two-step onboarding (their own phone and code only), so every account holder verifies their own phone without re-answering what the family already answered. No credential is ever emailed. Password floor is 8 characters everywhere (shared schema). Discovery is handled in chat: the moment a parent tells Eva they are on the journey as a couple, Eva's reply carries a one-time "Add my partner" card that opens the Invite Member page.
- Undecided: launch date for 2.0 and the exact set of providers live at launch.

## Brand Commitments

- Name: GoStork. The logo is a stork carrying a bundle, provided as five baked image assets (light, dark, with and without wordmark, favicon) that do not recolor with the theme.
- Live brand template: "GoStork Teal", primary `#08726F`, accent `#8F51A3`, with secondary cream, brand-success green, and brand-warning amber. All colors, radii, and type come from brand CSS variables managed on the Brand Settings page; nothing is hardcoded.
- Voice: warm, direct, second person, never third person about the reader. Positive opening. No em dashes or en dashes anywhere, hyphen-minus only.
- UX doctrine: full pages and inline expansion instead of modals (native mobile apps are planned). Tab state lives in the URL. Every chat attachment has a visible download icon. Numeric inputs format thousands with commas.
- Dual-audience system messages address each reader in second person from their own side.

## Evidence on Hand

The founder confirmed on 2026-09-15 that the following exist: real parent testimonials and reviews from GoStork 1.0, a true provider network count, and press or partner logos GoStork is allowed to display. None of them are checked into this repository yet. Before any surface cites a quote, a number, or a logo, obtain the exact asset or figure from the founder and record its path here. Do not paraphrase a testimonial, round a count, or use a placeholder logo in the meantime.

Also on hand in the product: CDC ART clinic outcome data joined by clinic id, provider cost sheets, and live donor and surrogate rosters with photos.

## Product Principles

1. **Guide, do not list.** Every surface should feel like a knowledgeable friend narrowing the field, not a catalog asking the parent to do the work.
2. **Protect the parent's identity until they commit.** Anonymity in early Q&A is a product feature, not a technical detail.
3. **One context, carried everywhere.** Nothing the parent has told Eva is asked again by a form, a provider, or a card.
4. **Calm under load.** Parents arrive stressed. Surfaces reduce decisions per screen, never add urgency or dark patterns, and are readable one-handed at night.
5. **Providers get speed, parents get care.** Provider tools optimize for scan and throughput; parent surfaces optimize for trust and clarity.

## Accessibility & Inclusion

- WCAG 2.1 AA is a hard floor on every surface: contrast, keyboard operability, focus visibility, and screen-reader semantics.
- Inclusive family language and imagery are binding. Never assume a mother-and-father couple. LGBTQ+ parents, single parents by choice, and international parents are first-class in copy, forms, illustrations, and photography. Forms use "Parent 1 / Parent 2" style slots, not gendered roles.
