## Overview

GoStork is a multi-tenant fertility marketplace connecting Intended Parents with fertility service Providers (IVF Clinics, Egg Donor Agencies, Surrogacy Agencies, Egg/Sperm Banks, Legal Services). It aims to streamline discovery, comparison, scheduling, and engagement within the fertility industry. Key capabilities include comprehensive provider profiles, enhanced user experience, improved operational efficiency, and AI integration for advanced analytics, cost sheet processing, and sophisticated booking. The vision is to be the leading digital marketplace, simplifying the fertility journey and offering significant market potential.

## User Preferences

Always use Claude Sonnet 4.6 for all coding, planning, and debugging tasks in this project. Apply maximum effort to security and multi-tenant logic.

**No dialogs/modals/popups:** Always use full pages or inline expandable sections instead of dialogs, modals, or popups. The app is designed with future native mobile apps in mind, where modals don't translate well. Dialogs are only acceptable for simple destructive-action confirmations (e.g., "Are you sure you want to delete?").

**No duplicate code:** Always reuse existing components, utilities, and logic. Before writing new code, check if similar functionality already exists elsewhere in the codebase. Extract shared logic into reusable components or utility files rather than copying across pages or features.

**Always use brand settings — never hardcode visual styles:** All colors, button shapes, typography (font families, weights, sizes), and border radii must come from the brand CSS variables (e.g., `--primary`, `--brand-success`, `--brand-warning`, `--foreground`, `--muted`, `--radius`, `font-heading`, `font-body`, `font-ui`). Never hardcode hex colors, Tailwind color utilities (e.g., `bg-amber-500`), font families, or border-radius values. Always reference the brand system so the entire app stays consistent and can be restyled from the Brand Settings page.

**Preserve tab/view state on navigation:** All tab state in pages must be stored in URL search params (via `useSearchParams` with `{ replace: true }`), Redux, or sub-routes — never in local `useState`. This ensures the browser back button always returns users to the exact tab they were on. Every back button must navigate to the correct page AND tab. Use `navigate(-1)` when the source page varies, or explicit URLs with `?tab=` params when the destination is fixed.

**All notifications must use SendGrid and Twilio templates:** Every email notification must use a SendGrid dynamic template (`templateId` + `templateData` via `dispatchNotification`). Every SMS notification must use a Twilio Content Template (`contentSid` + `contentVars` via `dispatchSmsTemplate`). Never hardcode HTML email bodies or send raw plain-text SMS. If the required templates don't exist yet, create them first via the SendGrid and Twilio APIs before writing the notification code.

## System Architecture

**UI/UX Decisions:**
- Prioritizes full pages; dialogs for destructive actions only.
- Enforces single-page scrolls.
- Utilizes a consistent brand system via CSS variables.
- Mobile-responsive design with horizontal top navigation for desktop and a fixed bottom tab bar for mobile.
- Marketplace uses `SwipeDeckCard` for unified display, supporting multi-column grids (desktop) and swipe decks (mobile).
- Multi-step onboarding with single-question-per-page, progress bar, and smooth transitions.
- AI Matchmaker selection features animated transitions.

**Technical Implementations & Design Choices:**
- **Backend:** NestJS, Prisma ORM, PostgreSQL.
- **Authentication:** Dual-mode (Passport.js/JWT), Redis for sessions, multi-role RBAC.
- **Calendar & Scheduling:** Calendly-like system with Google, Microsoft, and Apple Calendar integrations, timezone-aware slots.
- **Notification System:** SendGrid for email, Twilio for SMS, exclusively using dynamic templates.
- **AI-Powered Data Management:** Google Gemini for scraping, syncing, and bulk PDF uploads with multimodal OCR fallback. Dynamic cost sheet parsing with admin approval.
- **Marketplace Gating:** Provider/donor visibility controlled by service approval.
- **Telehealth:** HIPAA-compliant video calls via Daily.co with consent-gated recording to Google Cloud Storage and Google Speech-to-Text transcription.
- **In-App Notifications:** Database-backed, real-time system using Server-Sent Events (SSE).
- **Frontend:** React, Vite, React Router v6, TanStack Query, shadcn/ui, Redux Toolkit.
- **State Management:** Redux for global state, URL search params/sub-routes for tab/view state persistence.
- **Parent Experience Routing:** Dynamic routing based on `enableAiConcierge` and `parentExperienceMode` settings, redirecting to `/chat` or `/marketplace`.
- **Unified Conversations Page (`/chat`):** Serves both parents and providers. Parent view includes search, filters, pinned AI concierge, and collapsible provider groups. Provider view is a master-detail layout with session sidebar and chat transcript.
- **AI Matchmaker System:** Configurable personas, AI router with full user context, Biological Master Logic decision tree. Interactive UI with structured tags (e.g., `[[QUICK_REPLY]]`, `[[CURATION]]`, `[[MATCH_CARD]]`, `[[SAVE]]`, `[[HOT_LEAD]]`, `[[HUMAN_NEEDED]]`).
- **Human Escalation & Prep Doc Delivery:** `[[HOT_LEAD]]` triggers automated prep doc delivery (SendGrid email + in-chat `PrepDocCard`). `[[HUMAN_NEEDED]]` triggers human escalation with in-app notifications and a "Talk to GoStork Team" button for parents. Human messages are identified.
- **Admin Concierge Command Center:** `/admin/concierge-monitor` for live session monitoring and takeover; `/account/concierge` for system settings, persona CRUD, intelligence rules, and knowledge base management.
- **Profile Data Integration:** Comprehensive user profile management with robust validation.
- **CDC Data Pipeline:** Admin dashboard for CDC Socrata dataset syncing and scraping.
- **MCP Architecture Rule:** All AI data access for provider, surrogate, donor, clinic, and knowledge base data MUST use MCP server tools (`mcpClient.callTool()`). Direct `prisma.*` calls are restricted to operational writes.
- **Provider Self-Service Knowledge Base & RAG Engine:** `pgvector`-powered, with `KnowledgeChunk` and `ExpertGuidanceRule` models. Supports document uploads and website sync, uses OpenAI embeddings for similarity search, with tenant isolation and SSRF protection.
- **Silent Passthrough & Whisper Protocol:** AI uses `[[WHISPER:PROVIDER_ID]]` for provider-specific questions, creating anonymous `SilentQuery` records. Provider sees "Prospective Parent" with questions; parent identity is revealed only after the provider answers and the AI relays the response naturally.
- **Provider Consultation Booking (2-Step Join):** `[[CONSULTATION_BOOKING:PROVIDER_ID]]` initiates a 2-step process: sets `status: "CONSULTATION_BOOKED"` on session, notifies provider. Provider clicks "Join Group Chat" to set `providerJoinedAt`, reveal parent identity, and activate 3-way chat.
- **3-Way Co-Pilot Chat (Parent, Provider, Eva):** Session lifecycle: **ACTIVE** (anonymous whisper Q&A) → **CONSULTATION_BOOKED** (booking confirmed, provider can join) → **PROVIDER_JOINED** (active 3-way chat with parent identity revealed). Provider inbox shows per-parent entries with state-based badges.
- **Shared Parent Account Sessions:** All users on the same `parentAccountId` share AI chat sessions. Messages are identifiable by `senderName`. Notifications are sent to all account members.
- **PandaDoc Integration Phase 1:** Native document management for agreements. `Agreement` model tracks lifecycle. Providers configure `pandaDocTemplateId`. Backend service creates documents, polls readiness, and sends for signature. Includes idempotency guard.

## External Dependencies

-   **PostgreSQL (Supabase):** Primary database.
-   **Redis:** Session store.
-   **Google Gemini 2.0 Flash / 2.5 Flash:** AI for scraping, data extraction, and OCR.
-   **SendGrid:** Email notifications.
-   **Twilio:** SMS notifications.
-   **Google Calendar API:** Calendar synchronization.
-   **Microsoft Graph API:** Outlook/Office 365 Calendar synchronization.
-   **CalDAV (via `tsdav` library):** Apple iCloud Calendar synchronization.
-   **Daily.co:** Video conferencing.
-   **Google Cloud Storage:** Recording storage and cost sheet file storage.
-   **Google Speech-to-Text API:** Transcription.
-   **OpenAI:** Embeddings for RAG engine and profile vector search (`text-embedding-3-small`).
-   **Statically served uploads:** For user-uploaded images.
-   **Image Proxy:** For external images.