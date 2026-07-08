# GoStork Tech Stack

> **How this file stays current:** the curated overview below is hand-maintained.
> The **Dependency inventory** at the bottom is **auto-generated from
> `package.json`** by `npm run tech-stack` (run automatically by the pre-commit
> hook whenever `package.json` is staged). When you add, remove, or change a
> dependency or integration, the inventory updates itself; update the curated
> prose to match. A brand-new package that isn't categorized yet shows up under
> "Other (review & categorize)" so it's never missed.

## Frontend
- **React 18** + **TypeScript**, built with **Vite**
- **React Router v6** for routing
- **Redux Toolkit** + `react-redux` (global state); **TanStack Query v5** (server state)
- **shadcn/ui** on **Radix UI** primitives, styled with **Tailwind CSS** (`tailwind-merge`, `tailwindcss-animate`)
- **Framer Motion** (animation), `canvas-confetti` (celebration bursts), **lucide-react** + `react-icons` (icons)
- **react-hook-form** (forms); `react-big-calendar` + `react-day-picker` (scheduling); `embla-carousel`, `react-easy-crop`, `react-resizable-panels`

## Backend
- **NestJS 11** on **Express 5** (`@nestjs/platform-express`)
- **Auth:** Passport.js + JWT, with `express-session` stored in **PostgreSQL** via `connect-pg-simple` (no Redis), multi-role RBAC
- **API docs:** Swagger (`@nestjs/swagger`)
- **MCP architecture:** all provider/donor/surrogate/clinic/KB reads go through MCP server tools
- **Dev:** `tsx server/index.ts`; **Build:** esbuild → `dist/index.cjs` (also serves the built client from `dist/public`)

## Database & data
- **PostgreSQL** (hosted on **Supabase**) - primary DB *and* session store
- **Prisma 7** ORM (`@prisma/client` + `@prisma/adapter-pg`, `pg` driver)
- **pgvector** for embeddings (donor/surrogate profile vectors + RAG `KnowledgeChunk`), HNSW cosine indexes
- **Zod** (`zod`, `class-validator`) for validation; `@modelcontextprotocol/sdk` powers the MCP server/tools

## Scraping & background jobs
- **Playwright** (headless browser) + **Cheerio** (HTML parsing) for the donor/clinic sync scrapers
- **2captcha** for reCAPTCHA solving during scraper logins
- **node-cron** for the in-process nightly sync scheduler (runs on the iMac)

## Document & media processing
- **sharp** - image resize/processing (profile photos, face-match prep)
- **pdf-parse** / **pdfjs-dist** / **pdfkit** - cost-sheet parsing + receipt/invoice PDF generation
- **mammoth** (Word) + **exceljs** (spreadsheets) - document ingestion

## AI / ML
- **Google Gemini** (`@google/generative-ai`, `gemini-3.5-flash`) - concierge Tier 1, scraping, OCR/vision, cost-sheet parsing, look-alike attribute detection
- **Anthropic Claude** (`@anthropic-ai/sdk`) - concierge Tier 2 reasoning
- **AWS Rekognition** (`@aws-sdk/client-rekognition`) - look-alike face matching
- **gemini-embedding-001** - profile/KB vector embeddings (migrated off OpenAI)
- **Google Cloud Speech-to-Text** (`@google-cloud/speech`) - telehealth transcription

## Integrations
- **SendGrid** - email (all via `buildBrandedEmail()`)
- **Twilio** - SMS (Content Templates)
- **Daily.co** (`@daily-co/daily-js`) - HIPAA video calls
- **Stripe** (`stripe`, `@stripe/react-stripe-js`) - payments
- **Calendars:** Google APIs (`googleapis`) for Google Calendar + Gmail; **Microsoft Graph** for Outlook; **CalDAV** (`tsdav`) for Apple iCloud
- **PandaDoc** (`pandadoc-editor`) - agreement signing
- **Google Cloud Storage** (`@google-cloud/storage`) - recordings, photos, cost-sheet files
- **2captcha** - scraper reCAPTCHA solving

## Infrastructure / deployment
- **Replit** - production web traffic
- **Always-on iMac** - nightly scraper sync (in-process node-cron via launchd `LaunchDaemon`)
- **Local Mac** - dev (port 5001 + **ngrok** tunnel at `polygynous-vergie-coyly.ngrok-free.dev`)
- All three share the same Supabase Postgres DB

## Dependency inventory

<!-- AUTO-GENERATED:DEPS START -->
_Auto-generated from package.json by `npm run tech-stack` - do not edit between the AUTO markers._

### Runtime dependencies

**AI / ML**
- `@anthropic-ai/sdk@^0.91.1`
- `@aws-sdk/client-rekognition@^3.1075.0`
- `@google-cloud/speech@^7.2.1`
- `@google/genai@^1.43.0`
- `@google/generative-ai@^0.24.1`
- `@modelcontextprotocol/sdk@^1.27.1`

**Frontend / UI**
- `@dnd-kit/core@^6.3.1`
- `@dnd-kit/sortable@^10.0.0`
- `@dnd-kit/utilities@^3.2.2`
- `@hookform/resolvers@^3.10.0`
- `@radix-ui/react-accordion@^1.2.4`
- `@radix-ui/react-alert-dialog@^1.1.7`
- `@radix-ui/react-aspect-ratio@^1.1.3`
- `@radix-ui/react-avatar@^1.1.4`
- `@radix-ui/react-checkbox@^1.1.5`
- `@radix-ui/react-collapsible@^1.1.4`
- `@radix-ui/react-context-menu@^2.2.7`
- `@radix-ui/react-dialog@^1.1.15`
- `@radix-ui/react-dropdown-menu@^2.1.7`
- `@radix-ui/react-hover-card@^1.1.7`
- `@radix-ui/react-label@^2.1.3`
- `@radix-ui/react-menubar@^1.1.7`
- `@radix-ui/react-navigation-menu@^1.2.6`
- `@radix-ui/react-popover@^1.1.7`
- `@radix-ui/react-progress@^1.1.3`
- `@radix-ui/react-radio-group@^1.2.4`
- `@radix-ui/react-scroll-area@^1.2.4`
- `@radix-ui/react-select@^2.1.7`
- `@radix-ui/react-separator@^1.1.3`
- `@radix-ui/react-slider@^1.2.4`
- `@radix-ui/react-slot@^1.2.0`
- `@radix-ui/react-switch@^1.1.4`
- `@radix-ui/react-tabs@^1.1.4`
- `@radix-ui/react-toast@^1.2.7`
- `@radix-ui/react-toggle@^1.1.3`
- `@radix-ui/react-toggle-group@^1.1.3`
- `@radix-ui/react-tooltip@^1.2.0`
- `@reduxjs/toolkit@^2.11.2`
- `@stripe/react-stripe-js@^6.4.0`
- `@tanstack/react-query@^5.60.5`
- `class-variance-authority@^0.7.1`
- `clsx@^2.1.1`
- `cmdk@^1.1.1`
- `embla-carousel-react@^8.6.0`
- `framer-motion@^11.18.2`
- `input-otp@^1.4.2`
- `lucide-react@^0.453.0`
- `next-themes@^0.4.6`
- `react@^18.3.1`
- `react-big-calendar@^1.19.4`
- `react-day-picker@^8.10.1`
- `react-dom@^18.3.1`
- `react-easy-crop@^5.5.7`
- `react-hook-form@^7.55.0`
- `react-icons@^5.4.0`
- `react-redux@^9.2.0`
- `react-resizable-panels@^2.1.7`
- `react-router-dom@^6.30.3`
- `recharts@^2.15.2`
- `tailwind-merge@^2.6.0`
- `tailwindcss-animate@^1.0.7`
- `tw-animate-css@^1.2.5`
- `vaul@^1.1.2`

**Backend (server)**
- `@nestjs/common@^11.1.14`
- `@nestjs/core@^11.1.14`
- `@nestjs/jwt@^11.0.2`
- `@nestjs/passport@^11.0.5`
- `@nestjs/platform-express@^11.1.14`
- `@nestjs/swagger@^11.2.6`
- `class-transformer@^0.5.1`
- `class-validator@^0.14.3`
- `connect-pg-simple@^10.0.0`
- `dotenv@^17.2.4`
- `express@^5.0.1`
- `express-session@^1.18.1`
- `jsonrepair@^3.14.0`
- `memorystore@^1.6.7`
- `node-cron@^4.2.1`
- `passport@^0.7.0`
- `passport-jwt@^4.0.1`
- `passport-local@^1.0.0`
- `reflect-metadata@^0.2.2`
- `ws@^8.18.0`
- `zod@^3.24.2`
- `zod-validation-error@^3.4.0`

**Database / ORM**
- `@prisma/adapter-pg@^7.4.0`
- `@prisma/client@^7.4.0`
- `@prisma/config@^7.3.0`
- `drizzle-orm@^0.39.3`
- `drizzle-zod@^0.7.0`
- `pg@^8.16.3`

**Scraping & automation**
- `cheerio@^1.2.0`
- `playwright@^1.60.0`

**Document processing**
- `exceljs@^4.4.0`
- `mammoth@^1.12.0`
- `pdf-parse@^2.4.5`
- `pdfjs-dist@^5.4.296`
- `pdfkit@^0.18.0`
- `sharp@^0.34.5`

**Integrations**
- `@daily-co/daily-js@^0.87.0`
- `@google-cloud/storage@^7.19.0`
- `@stripe/stripe-js@^9.6.0`
- `googleapis@^148.0.0`
- `ical.js@^2.2.1`
- `pandadoc-editor@^1.0.1`
- `stripe@^22.1.1`
- `tsdav@^2.1.8`
- `twilio@^6.0.0`

**Utilities**
- `@jridgewell/trace-mapping@^0.3.25`
- `date-fns@^3.6.0`
- `geoip-lite@^2.0.2`
- `libphonenumber-js@^1.12.41`

**Build / tooling**
- `@types/multer@^2.1.0`
- `@types/node-cron@^3.0.11`
- `@types/passport-jwt@^4.0.1`
- `@types/pdf-parse@^1.1.5`
- `@types/pdfkit@^0.17.6`
- `@types/react-big-calendar@^1.16.3`
- `@types/sharp@^0.31.1`
- `esbuild@^0.27.4`
- `rollup@^4.59.0`
- `tsx@^4.21.0`

**Other (review & categorize)**
- `canvas-confetti@^1.9.4`

### Dev / build dependencies

**Frontend / UI**
- `@tailwindcss/typography@^0.5.15`
- `tailwindcss@^3.4.17`

**Database / ORM**
- `drizzle-kit@^0.31.8`

**Build / tooling**
- `@replit/vite-plugin-cartographer@^0.4.4`
- `@replit/vite-plugin-dev-banner@^0.1.1`
- `@replit/vite-plugin-runtime-error-modal@^0.0.3`
- `@tailwindcss/vite@^4.1.18`
- `@types/canvas-confetti@^1.9.0`
- `@types/connect-pg-simple@^7.0.3`
- `@types/express@^5.0.0`
- `@types/express-session@^1.18.0`
- `@types/geoip-lite@^1.4.4`
- `@types/node@20.19.27`
- `@types/passport@^1.0.16`
- `@types/passport-local@^1.0.38`
- `@types/react@^18.3.11`
- `@types/react-dom@^18.3.1`
- `@types/ws@^8.5.13`
- `@vitejs/plugin-react@^4.7.0`
- `autoprefixer@^10.4.20`
- `postcss@^8.4.47`
- `typescript@5.6.3`
- `vite@^7.3.0`

<!-- AUTO-GENERATED:DEPS END -->
