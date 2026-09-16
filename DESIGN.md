---
name: GoStork
description: A warm concierge desk for family building - Stork Teal on warm sand, soft pills, one calm voice.
colors:
  stork-teal: "#08726F"
  orchid: "#8F51A3"
  warm-sand: "#F6F3EE"
  linen: "#F3EBE1"
  paper: "#FFFFFF"
  ink: "#0F172A"
  ink-soft: "#0A0A0A"
  slate-label: "#475569"
  slate-muted: "#57667B"
  fog: "#F4F4F5"
  warm-hairline: "#D9D2C6"
  success-green: "#10B981"
  warning-amber: "#F59E0B"
  error-red: "#EF4444"
  legacy-ring-green: "#26584A"
  service-surrogacy: "#8F51A3"
  service-egg-donation: "#B97D10"
  service-sperm-donation: "#3E7BC0"
  service-ivf: "#0B7C74"
  service-legal: "#9E3B5E"
  deck-night: "#17181C"
  deck-night-raised: "#23252A"
  swipe-pass: "#FF4B4B"
  swipe-save: "#2DE182"
  swipe-undo: "#FFB300"
  swipe-chat: "#9B51E0"
  swipe-compare: "#2D9CDB"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  value:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0em"
  eyebrow:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.055em"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.03em"
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
  chat-mobile:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "21px"
    fontWeight: 400
    lineHeight: 1.25
  chat-desktop:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.25
rounded:
  control: "2rem"
  container: "2rem"
  bubble: "20px"
  pill: "999px"
  calendar: "12px"
  event: "6px"
  avatar: "50%"
spacing:
  hairline-gap: "3px"
  xs: "4px"
  sm: "8px"
  md: "16px"
  pair: "22px"
  lg: "24px"
  xl: "32px"
  header: "64px"
  bottom-bar: "68px"
components:
  button-primary:
    backgroundColor: "{colors.stork-teal}"
    textColor: "{colors.paper}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-primary-lg:
    backgroundColor: "{colors.stork-teal}"
    textColor: "{colors.paper}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 32px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.linen}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "{colors.error-red}"
    textColor: "{colors.paper}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.container}"
    padding: "8px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.container}"
    padding: "24px"
  chip:
    backgroundColor: "{colors.linen}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  badge-primary:
    backgroundColor: "{colors.stork-teal}"
    textColor: "{colors.paper}"
    typography: "{typography.micro}"
    rounded: "{rounded.control}"
    padding: "2px 10px"
  nav-pill-active:
    backgroundColor: "{colors.stork-teal}"
    textColor: "{colors.paper}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  nav-pill-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.stork-teal}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  nav-pill-inactive-hover:
    backgroundColor: "{colors.linen}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
  chat-bubble-own:
    backgroundColor: "{colors.stork-teal}"
    textColor: "{colors.paper}"
    typography: "{typography.chat-mobile}"
    rounded: "{rounded.bubble}"
    padding: "6px 16px"
  chat-bubble-eva:
    backgroundColor: "{colors.fog}"
    textColor: "#1F2937"
    typography: "{typography.chat-mobile}"
    rounded: "{rounded.bubble}"
    padding: "6px 16px"
  chat-bubble-provider:
    backgroundColor: "{colors.linen}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.chat-mobile}"
    rounded: "{rounded.bubble}"
    padding: "6px 16px"
  quick-reply:
    backgroundColor: "transparent"
    textColor: "{colors.stork-teal}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
---

# Design System: GoStork

## Overview

**Creative North Star: "The Warm Concierge Desk"**

GoStork is a fertility matching concierge, and the interface is built to feel like sitting at a calm, sunlit front desk with someone who already knows your file. The page is warm sand, not white; white is reserved for the cards that hold real content, so every card reads as a sheet of paper placed on the desk. One voice speaks throughout: Stork Teal on every primary action, every active tab, and every message the parent sends. A second, softer voice, Orchid, marks the parts of the product that are not the parent's own doing: Eva's prompts, alternate emphasis, and the surrogacy service line. Nothing shouts. Green, amber, and red are kept out of decoration entirely so that when they appear they mean status.

The form language is soft to the point of being a signature: controls and containers share a single 2rem radius, so 48px inputs and buttons become full pills and cards become deeply rounded trays. Type is the platform's own system stack (SF Pro on Apple devices), set generously with a 1.6 body line height, because parents read this app on a phone at night. Density is loose on parent surfaces and tightens on provider work surfaces, where the same tokens carry a CRM, a calendar, and a document queue.

The system's feel is **playful and tactile**: pressable things lift 1px and brighten slightly on hover, and press down with a 2% scale. The `hover-elevate` and `active-elevate-2` classes on every button and badge carry this, and they fire only on elements that can actually be pressed, so a badge in a sentence never jumps. Reduced-motion users get the color change without the movement.

**Key Characteristics:**
- Warm sand page with white paper cards separated by a visible warm hairline, not by shadow.
- One accent voice (Stork Teal) for action; Orchid for Eva and alternate emphasis; status hues never decorate.
- A single 2rem radius makes every control a pill and every card a tray.
- System font stack, 700-weight headings, 500-weight UI labels, 1.6 body leading.
- Every visual value is a brand CSS variable driven by the Brand Settings page; nothing is hardcoded.
- Full pages and inline expansion instead of modals; tab state lives in the URL.

## Colors

The palette is a warm neutral ground with one saturated teal voice, one muted purple counter-voice, and five fixed service hues that are used only to name a service line.

### Primary
- **Stork Teal** (#08726F, HSL 178 87% 24%): the brand's single call-to-action color. Primary buttons, the active navigation pill, the active underline tab, the parent's own chat bubbles, selected filter pills at 10% tint, the "today" wash on the calendar at 4%. Also the default inactive text color of navigation links, so the nav reads as brand even at rest. Not for large fills or decorative panels.

### Secondary
- **Linen** (#F3EBE1, HSL 33 43% 92%): the recede color. Secondary buttons, attribute chips, the swipe card's cover sheet, provider chat bubbles, and any surface that should sit under a primary element without competing. Text on Linen is Ink Soft.
- **Orchid** (#8F51A3, HSL 285 34% 48%): the accent. Eva's prompt eyebrows, the "Sponsored" badge, the gradient partner to Stork Teal in the text-gradient and monogram placeholder, and the Surrogacy service tag. Orchid on white foreground text. Use it for alternate emphasis, never as a second CTA color.

### Neutral
- **Warm Sand** (#F6F3EE, HSL 37 31% 95%): the page background everywhere. Chosen in August 2026 specifically to lift white cards off the page.
- **Paper** (#FFFFFF): cards, inputs, the desktop header, the mobile bottom bar, popovers. Paper is content; the desk behind it is sand.
- **Ink** (#0F172A): body text on Warm Sand. **Ink Soft** (#0A0A0A): text on Paper cards and Linen surfaces.
- **Slate Label** (#475569): field labels, the one place a label is allowed to recede below the value it names.
- **Slate Muted** (#57667B): helper text, timestamps, calendar gutters, micro labels. Darkened from #64748B on 2026-09-15 so it clears 4.5:1 on Warm Sand (5.3:1), Paper (5.9:1), Fog (5.3:1), and Linen (5.0:1).
- **Fog** (#F4F4F5): muted fills, Eva's chat bubble, calendar off-range days.
- **Warm Hairline** (#D9D2C6, HSL 38 20% 81%): every border, divider, and card edge. Warm, not gray, so it belongs to the sand.

### Status (reserved)
- **Success Green** (#10B981), **Warning Amber** (#F59E0B), **Error Red** (#EF4444): approval, warnings, cancellations, destructive buttons, the calendar's current-time line. They never tint a surface for decoration.
- **Error text** (`--brand-error-text`, HSL 0 72% 40%): inline validation and send errors through the `.t-error` class. Error Red is a fill colour; as 13px text on Warm Sand it measures 3.4:1, so text uses this darker step (about 6:1).
- **Focus ring**: Stork Teal. (The pre-teal green #26584A was still the live ring until 2026-09-15; it is kept in the token list only so old screenshots can be read.)

### Service identity (fixed)
One hue per service line, rendered only through the shared ServiceTag: **Surrogacy** Orchid (#8F51A3), **Egg Donation** gold (#B97D10), **Sperm Donation** blue (#3E7BC0), **IVF** teal (#0B7C74), **Legal** burgundy (#9E3B5E). Approval renders as a small check inside the tag; the tag is never dyed green.

### Deck (marketplace swipe screen only)
**Deck Night** (#17181C) and **Deck Night Raised** (#23252A) turn the Discover and Saved screens near-black so photo cards carry the light. The five swipe action colors (pass red, save green, undo amber, chat purple, compare blue) exist only for the deck's action buttons and their hover glow.

### Named Rules
**The One Voice Rule.** Stork Teal is the only color that asks the parent to act. If two teal elements compete on one screen, one of them is wrong.
**The Status Is Not Decoration Rule.** Green, amber, and red appear only when something is approved, needs attention, or failed. Reach for Linen or Orchid for any tinted surface before touching a status hue or a gray.
**The Warm Hairline Rule.** Cards separate from the page by Paper-on-Sand plus a 1px Warm Hairline. Shadow is not how a resting card earns its edge.

## Typography

**Display Font:** system stack (-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, sans-serif)
**Body Font:** the same system stack
**Label/UI Font:** the same stack at weight 500

**Character:** Native, unobtrusive, and fast. The live brand deliberately uses the platform's own face so the app feels installed rather than visited, which matters for the planned native mobile apps. Hierarchy is carried by weight and size, not by a second family. The CSS, client, and server fallbacks mirror the live row so the first paint matches.

### Hierarchy
- **Display / Page title** (700, 30px, 1.2): the one title at the top of a page.
- **Headline / Card heading** (700, 24px, 1.2): a card's title. The swipe card's name line runs larger (29px) by its own brand setting.
- **Title / Section title** (600, 18px, 1.3): section headers inside a page or card.
- **Body** (400, 16px, 1.6): running text. Base size is 16 with a 1.25 type-scale ratio.
- **Value** (400, 17px, 1.45): the answer in a label/value pair and the answer in a prompt block. Deliberately one step larger than body so the value is the anchor.
- **Label** (500, 14px, 1.35, Slate Label): the key in a label/value pair. Sentence case, no tracking.
- **Eyebrow** (600, 12px, uppercase, 0.055em, Orchid): the question above a prose answer in a prompt block. Emphasis is inverted on purpose: the question is small and colored, the answer is large and dark.
- **Micro label** (500, 12px, uppercase, 0.03em, Slate Muted): keys in dense cards and tables; pairs with a 15px micro value.
- **UI / Button** (500, 14px): buttons, badges, chips, nav links. Buttons keep sentence case; the `buttonTextCase` setting is "normal".
- **Helper** (400, 13px, Slate Muted): descriptions under fields and cards.
- **Chat** (400, 21px mobile / 15px desktop, 1.25): message bubbles. Mobile chat runs large because it is the parent's main surface.

### Named Rules
**The Value Leads Rule.** In any label/value pair the value is larger and darker than its label. Never style a label to compete.
**The Brand Variable Rule.** Content text renders through the Field, PromptBlock, MicroField, and AttributeChip primitives or the `.t-*` classes. A Tailwind `text-*` size at a call site is a bug.

## Layout

The app is a single-column scroll on phones and a centered canvas on desktop. Page content sits inside a container capped at 1800px with 16px side padding on phones, 24px from the md breakpoint, and 32px from lg. Chat and the concierge monitor break out of that container and own the viewport.

Desktop navigation is a fixed 64px Paper header with a bottom Warm Hairline and links centered as pills. Mobile navigation is a fixed 68px Paper bottom bar, icon-only in the live setting, with safe-area padding below and no shadow. Pages animate in with a 500ms fade and 16px rise.

Cards use 24px internal padding on all sides with header, content, and footer stacking and the content region dropping its top padding. Label/value pairs sit in a FieldGrid with a 22px row gap and a 3px gap between a label and its value; a pair whose label passes 70 characters or whose value passes 140 spans the full row. Prompt blocks stack with a 22px gap and a hairline between them.

Density tightens on provider surfaces: the calendar runs 72px hour rows, 11px gutter labels, and 12px event text; tables use micro labels. Parent surfaces stay loose.

Breakpoints follow Tailwind defaults (sm 640, md 768, lg 1024, xl 1280). The bottom bar and header swap at md.

## Elevation & Depth

The system is tonal-first with shadow on lift. Depth at rest comes from Paper cards on the Warm Sand page plus a 1px Warm Hairline; a resting card carries only the faintest shadow (`shadow-sm`). Shadows are spent on things that genuinely float: the swipe card in the deck, the sticky desktop header, popovers and dropdowns, and the hover state of a swipe action button. The mobile bottom bar is flat in the live setting.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`): default card, the active nav pill. Barely there; the hairline does the work.
- **Raised** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): popovers, dropdown menus, the swipe card's floating expand button.
- **Floating** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): the swipe deck card, sheets and drawers.
- **Glow** (`box-shadow: 0 0 12px color-mix(in srgb, <swipe-color> 30%, transparent)`): swipe action buttons on hover, in their own action color.
- **Selection ring** (`box-shadow: 0 0 0 2px hsl(var(--primary) / 0.2)`): a selected calendar event.

### Named Rules
**The Shadow On Lift Rule.** A surface earns a shadow by floating above the page, not by being important. Cards at rest keep the hairline and lose the shadow.

## Shapes

One radius token, set to 2rem, governs both controls and containers, and it is the system's most recognizable trait. A 36px button or input becomes a full pill; a 48px login field is a pill; a card becomes a 32px-cornered tray. Chips, quick replies, and nav pills use 999px so they stay pills at any height. Chat bubbles use their own 20px radius so a tall multi-line message keeps readable corners rather than turning into a capsule. Avatars are circles. The calendar keeps a tighter 12px frame with 6px event chips because it is a dense provider tool.

Borders are always 1px Warm Hairline. Outline buttons and badges use a transparent-by-default outline variable so a border can be switched on later without shifting layout. The swipe card clips its photo with the container radius and a 3px transparent gutter so the deck's stacked cards never touch.

## Components

Controls are pills, cards are trays, and both carry the brand's variables so the Brand Settings page can restyle them without a code change.

### Buttons
- **Shape:** full pill (2rem radius on a 36px minimum height; 40px for lg, 48px where a page adds `h-12`)
- **Primary:** Stork Teal fill, Paper text, weight 500, 8px 16px padding, 1px border in the primary-border variable (currently transparent)
- **Secondary:** Linen fill, Ink Soft text, same geometry; the recede button
- **Outline:** transparent fill, inherits text color, 1px outline variable, extra-small shadow, shadow removed on press
- **Ghost:** transparent with a transparent border so toggling a border later never shifts layout
- **Destructive:** Error Red fill, Paper text
- **Sizes:** sm 32px min height and 12px text; icon 36px square; svg icons 16px
- **Focus:** 1px ring in Stork Teal
- **Hover:** brightness 1.04 and a 1px lift over 150ms. **Active:** brightness 0.96 and scale 0.98. Both through the elevate utilities; nothing per-button.
- **Disabled:** 50% opacity, pointer events off
- **Case:** sentence case, never uppercase

### Chips (AttributeChip)
- **Style:** Linen fill, Ink Soft text, 13px at weight 500, 5px 11px padding, 999px radius, no border
- **State:** a selected filter pill switches to Stork Teal at 10% tint with Stork Teal text and 12px text

### Badges
- **Style:** 14px UI text (per the live badge setting), 2px 10px padding, control radius, no wrapping
- **Variants:** primary (Stork Teal fill), secondary (Linen), destructive (Error Red), outline (transparent with outline variable). On the swipe card: Sponsored in Orchid at 90%, a success stat in Success Green at 90%, a requirements warning in Warning Amber at 90%, all with white text and an 11px icon

### ServiceTag
- **Style:** a small pill in the service's fixed hue; the one place a service line's color appears. Accepts any raw service string and normalizes it to five keys; unknown services render neutral
- **State:** approved shows a check inside the tag; pending a clock; declined an X. The tag never changes hue for status

### Cards / Containers
- **Corner Style:** 2rem container radius, overflow hidden
- **Background:** Paper on the Warm Sand page; Linen when the card must recede
- **Shadow Strategy:** Rest shadow only; see Elevation
- **Border:** 1px Warm Hairline
- **Internal Padding:** 24px; header stacks with 6px gaps; card title is Headline 24px 700; description is Helper 13px

### Inputs / Fields
- **Style:** 36px tall, Paper fill (input color set to white in live settings), 1px Warm Hairline, container radius, 12px horizontal padding, 16px text on phones so iOS never zooms, 14px from md
- **Focus:** 2px ring in the ring color with a 2px Warm Sand offset
- **Placeholder:** Slate Muted
- **Disabled:** 50% opacity, not-allowed cursor
- **Numbers:** the shared NumberInput formats thousands with commas as the user types; raw number inputs are not used
- **Date / time:** native appearance removed, left-aligned value

### Navigation
- **Desktop header:** fixed, 64px, Paper, bottom Warm Hairline at 40%, Rest shadow. Links are 14px weight 500 with a 16px icon, 8px 12px padding. Inactive links are Stork Teal text; hover fills Linen with Ink Soft text and rounds to a pill; the active link is a Stork Teal pill with Paper text and the Rest shadow. An "underline" header style exists behind a brand setting and swaps pills for a 2px bottom border.
- **Mobile bottom bar:** fixed, 68px, Paper, no shadow, icon-only in the live setting (36px icons; 13px labels appear in the icon-label style). Items are evenly spread, 200ms color transitions, and the bar hides on profile pages, the concierge page, agreement signing, and while the Explore sheet is open. On the marketplace deck the bar adopts the Deck Night Raised background.
- **Underline tabs:** Stork Teal text with a 2px transparent bottom border; active sets the border to Stork Teal.

### Chat (signature surface)
- **Bubbles:** 20px radius, 16px horizontal and 6px vertical padding, 85% max width, 21px text on phones and 15px on desktop at 1.25 leading. The parent's own bubbles are Stork Teal with Paper text; Eva's are Fog (#F4F4F5) with near-ink text (#1F2937); provider bubbles are Linen; text color auto-picks for contrast when unset. Borders are transparent unless a brand setting turns them on.
- **Quick replies:** 999px pills, 13px text, 6px 14px padding, 1px border. The default style is primary outline; decline options render secondary; multi-select options render outline.
- **Timestamps:** 11px at 45% opacity. **Composer:** 36px tall, 17px text on phones, 15px on desktop.
- **Cards in chat:** match cards, prep-doc cards, and attachment cards render inline. Every attachment card carries a visible download icon.

### Swipe Deck Card (signature surface)
The marketplace card fills its slot with a 3px transparent gutter, container radius, Floating shadow, and a photo hero. Without a photo it shows a Stork Teal to Orchid diagonal gradient with a 72px to 160px monogram in white at 95%. A top gradient from black at 50% keeps overlaid controls legible. The cover sheet is Linen with a centered 88px monogram or 72px logo tile (12px radius, Paper, Rest shadow), a 20px heading, and 13px Slate Muted metadata. Action buttons glow in their own swipe color on hover.

## Do's and Don'ts

### Do:
- **Do** put every color, radius, font, weight, and size through a brand CSS variable or the content typography primitives; the Brand Settings page must be able to restyle it.
- **Do** reach for Linen (bg-secondary) or Orchid (bg-accent) for any tinted surface before Fog or a gray.
- **Do** keep the 2rem pill geometry on every control and container; it is the system's signature.
- **Do** separate resting cards with Paper-on-Sand plus the 1px Warm Hairline, and spend shadows only on floating surfaces.
- **Do** render every service name through ServiceTag and every attachment through the shared attachment card.
- **Do** address each reader in second person in any shared parent-provider message.
- **Do** keep 16px input text on phones so iOS does not zoom, and 44px or larger tap targets on the bottom bar.
- **Do** meet WCAG 2.1 AA contrast: Ink on Warm Sand, Ink Soft on Paper and Linen, Paper on Stork Teal and Orchid all pass; Slate Muted clears AA on every brand surface at 13px and up.

### Don't:
- **Don't** hardcode a hex, a Tailwind color utility, a font family, or a radius at a call site.
- **Don't** use green, amber, or red to decorate; they are status-only.
- **Don't** introduce a second CTA color; Orchid is emphasis, never action.
- **Don't** open a dialog, modal, or popup for anything but a destructive confirmation; use a full page or inline expansion.
- **Don't** store tab or view state in local component state; it belongs in the URL.
- **Don't** describe a donor or surrogate in plain chat text without the match card.
- **Don't** use em dashes or en dashes anywhere in UI text.
- **Don't** add per-component hover or press styles; the shared elevate utilities are the one source of tactile feedback.
