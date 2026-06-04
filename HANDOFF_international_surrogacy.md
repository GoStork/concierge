# Handoff: International Surrogacy Programs (Mexico / Colombia)

> Self-contained handoff for a fresh Claude Code session. You have NO memory of
> the prior session - everything you need is below. Read it top to bottom, then
> run the **Test Plan**. Today's date context: built 2026-06-04.

---

## 1. What this feature does

GoStork is a fertility marketplace. Intended Parents can do surrogacy in the
**USA** (individual surrogate profiles, agency-led) or in **international
programs** (currently **Mexico** and **Colombia**; more countries later).

An international program is **agency-led and bundled**: a surrogacy agency plus
one or more partner IVF clinics in the same country deliver the whole journey
(IVF + surrogacy, sometimes + egg donor) as one package. The AI concierge ("Eva"
/ persona name varies) must:

1. Ask which **country** the parent wants *before* matching US clinics (so it
   doesn't waste time on US clinics a Colombia parent won't use).
2. Check the parent against **both** the agency's AND its partner clinic's
   "Parents Matching Requirements" before offering a program. If either rejects
   the parent, the whole program is blocked and the parent is told why.
3. Present a **country-level cost card** showing the **combined** cost of agency
   + clinic (+ egg donor), so the parent can compare Mexico vs Colombia
   apples-to-apples.

### The 4 parts (all implemented + on `main`)

| # | Part | Where it lives | Status |
|---|------|----------------|--------|
| 1 | Early country gate (ask country before US clinic cycle) | `conciergePromptSection` DB row `conversation_flow`, PHASE 3 "EARLY COUNTRY GATE" | ✅ live in DB |
| 2 | Combined agency + partner-clinic reject check | `conversation_flow` PATH A + `search_surrogacy_agencies` MCP tool | ✅ live |
| 3 | Admin UI to link agency ↔ partner IVF clinic(s) | `client/src/pages/admin-provider-edit-page.tsx` "Partner IVF Clinics" card | ✅ live |
| 4 | Merged country cost card (combined agency+clinic cost) | `CountryProgramCard` + `getCombinedCountryProgramCost` + `/country-program` endpoint | ✅ live, smoke-tested |

---

## 2. Architecture / how it works

### Data model
- `Provider.partnerProviderIds` (Json, array of provider ids) - on a **surrogacy
  agency**, lists the partner IVF clinic(s) for that country's program.
- Agency parent-matching fields: `surrogacyTwinsAllowed` (bool),
  `surrogacyCitizensNotAllowed` (Json array of country names).
- Clinic parent-matching fields: `ivfMaxAgeIp1`, `ivfMaxAgeIp2` (int),
  `ivfTwinsAllowed` (bool), `ivfAcceptingPatients` (Json array, e.g.
  `["single_woman","gay_couple","straight_couple",...]`), `ivfBiologicalConnection`.
- Costs: `CostProgram` (per provider) with `serviceTypes` tags
  (`"surrogacy" | "ivf_clinic" | "egg_donor" | "sperm_donor"`) and `country`.
  Totals are computed from `CostItem` rows (NOT stored) by
  `costs.service.ts#getProviderParentPrograms`.

### Conversation flow (the prompt)
The AI concierge prompt is **NOT** hardcoded - it lives in the DB table
`ConciergePromptSection` (one row per section, keyed by `key`). The file
`server/ai-prompt-defaults.ts` is the SEED + source of truth in git, but the
running prompt is whatever is in the DB. **To change prompt behavior you must
edit `ai-prompt-defaults.ts` AND push the section to the DB** (see §4). The DB is
cached in-process for 30s, so changes go live ~30s after the SQL UPDATE, no
restart needed.

Relevant sections: `conversation_flow` (cycles, gate, PATH A/B/C),
`matching_rules` (MATCH_CARD format).

Key flow for an international parent:
1. **PHASE 3 EARLY COUNTRY GATE**: if `needsClinic && needsSurrogate`, the AI
   delivers D1 (international education + `[[MULTI_SELECT:USA|Mexico|Colombia]]`)
   BEFORE any US clinic questions.
2. On D1 answer, AI emits `[[SAVE:{"surrogateCountries":"Mexico"}]]` and
   acknowledges the country by name.
3. Routing:
   - **International only** (Mexico/Colombia, no USA) → skip US clinic Cycle A,
     go to PATH A (agency-led).
   - **USA only** → normal US clinic cycle + US surrogates (PATH B).
   - **Both** → US clinic cycle first, then PATH A international (PATH C).
4. **PATH A** calls MCP tool `search_surrogacy_agencies` which returns each
   agency + its `partnerClinics[]` (with their matching reqs). The AI runs the
   **COMBINED PROGRAM HARD-REJECT CHECK** (agency reqs + every partner clinic's
   reqs). If a program passes, the AI emits a **CountryProgram** match card.

### The CountryProgram match card (Part 4)
- AI emits: `[[MATCH_CARD:{"name":"<agency>","type":"CountryProgram","country":"Colombia","reasons":[...],"providerId":"<agency id>"}]]`.
  **The AI emits NO dollar amounts** - the card hydrates authoritative cost.
- Card parsing/hydration: `server/ai-router.ts` (~line 5860 parse, ~line 5986
  `resolve_match_card`). `CountryProgram` falls through to the generic provider
  branch → returns agency logo/name.
- Client render: `client/src/pages/concierge-chat-page.tsx`
  - `interface MatchCard` has a `country?` field.
  - `MatchCardComponent` (~line 1923) dispatches `type==="CountryProgram"` →
    `CountryProgramCard` (added right before `AgencyMatchCard`, ~line 1811).
  - `CountryProgramCard` fetches `GET /api/costs/provider/:agencyId/country-program`
    and renders: country flag header, combined total, per-provider breakdown,
    reasons, "Book Consultation" (books with the agency).
- Endpoint: `server/src/modules/costs/costs.controller.ts`
  `GET provider/:agencyId/country-program` → `costsService.getCombinedCountryProgramCost`.
- Combiner: `server/src/modules/costs/costs.service.ts#getCombinedCountryProgramCost`
  - Reuses `getProviderParentPrograms` (the same matcher the parent profile
    uses) for the agency + each partner clinic. NO re-implemented math.
  - Bypasses the "complete your profile" gate via `implicitNeed="surrogacy"`
    (the parent is actively in the surrogacy flow).
  - **Role-aware**: when the agency has separate partner clinics, surrogacy cost
    comes from the AGENCY and IVF/egg from the CLINIC(s). When the agency IS the
    clinic (no partner ids, e.g. Mexico/Eggspecting), one provider supplies all
    legs. This prevents a clinic program over-tagged with "surrogacy" from
    dropping the agency fee.
  - Country label comes from the matched program's `country` field (the agency's
    *location* can be a US mailing state, e.g. Eggspecting reads "GA").
  - Returns `{ agencyId, agencyName, agencyLogo, country, combinedMinTotal,
    combinedMaxTotal, components[], missingServices[], isPartialProfile, hasCost }`.

---

## 3. Current data state (real IDs - use these for testing)

| Provider | Role | Country | ID |
|----------|------|---------|----|
| **Bioética & Derecho** | Surrogacy agency | Colombia | `30a45389-77cd-4188-b7c7-637444576d0e` |
| **Inser** | IVF clinic | Colombia | `8997f2a5-edf9-4f61-8f1c-e5c3bbb02b36` |
| **Eggspecting** | Agency + clinic (one company) | Mexico | `448564e2-4e7f-42d2-9578-5197161ea0ec` |

**Matching requirements:**
- **Bioética**: `surrogacyTwinsAllowed=true`, `surrogacyCitizensNotAllowed=["Italy"]`,
  `partnerProviderIds=["8997f2a5-...(Inser)"]` ← linked.
- **Inser**: `ivfMaxAgeIp1=55`, `ivfMaxAgeIp2=55`, `ivfTwinsAllowed=true`,
  accepts all family types.
- **Eggspecting**: `surrogacyTwinsAllowed=true`, `citizensNotAllowed=["Italy"]`,
  `ivfMaxAgeIp1=45`, `ivfMaxAgeIp2=50`, accepts all family types.

**Cost programs:**
- Bioética: "1 Surrogate Program" (~$49,490), "4 Surrogates Program" - tagged `[surrogacy]`.
- Inser: several IVF programs, "Package 3 Egg Don program" (~$30,800) - tagged
  `[ivf_clinic, surrogacy]` (note the over-tag).
- Eggspecting: "Mexico City Surrogacy & IVF" (~$99,900) - tagged
  `[ivf_clinic, surrogacy]`; "Mexico City Surrogacy" - tagged `[surrogacy]`.

**Verified combined costs (apples-to-apples):**
- **Colombia** = Inser IVF $30,800 + Bioética surrogacy $49,490 = **$80,290**
  (two providers, role-aware split).
- **Mexico** = Eggspecting combined "Surrogacy & IVF" = **$99,900** (one
  provider supplies both legs, so one combined line).

---

## 4. Infra & how to run / rebuild / restart

Everything runs **locally**, exposed to the browser via a reserved ngrok tunnel.
There is NO cloud deploy / CI. Pushing to GitHub `main` does NOT deploy.

- **Repo**: `/Users/eranamir/Documents/GitHub/concierge`
- **Build**: `npm run build` → client to `dist/public/`, server to
  `dist/index.cjs`, MCP server to `dist/mcp-server.cjs`. **Source edits are
  invisible until rebuilt.**
- **Run server**: `node dist/index.cjs` (listens on **port 5001**). Logs:
  `/tmp/gostork-server.log` if backgrounded.
- **ngrok**: `ngrok http --url=polygynous-vergie-coyly.ngrok-free.dev 5001`
  Public URL: `https://polygynous-vergie-coyly.ngrok-free.dev`
  The browser hits the ngrok URL, so after a server restart **always confirm
  ngrok is still up** (`curl -s https://polygynous-vergie-coyly.ngrok-free.dev/concierge -o /dev/null -w "%{http_code}"` should be 200). If ngrok died, restart it.

### Restart rules (project convention - follow exactly)
- **Client-only change** (`client/**`): `npm run build`, then tell user to hard
  refresh. No server/ngrok restart (Express serves fresh static from `dist/public/`).
- **Server / prisma / mcp change** (`server/**`, `prisma/**`): `npm run build` +
  kill port 5001 + restart `node dist/index.cjs` + verify ngrok. Run
  `npx prisma generate` first if `prisma/schema.prisma` changed.
- **Prompt change**: edit `server/ai-prompt-defaults.ts` AND push the section to
  the DB (below). Live in ~30s, no restart.
- **Before restarting**, check no test run is active:
  `ps aux | grep -E "test-ai-concierge|tsx scripts"` - if running, hold.

### Restart one-liner (server + ngrok)
```bash
cd /Users/eranamir/Documents/GitHub/concierge
npm run build && lsof -ti:5001 | xargs kill -9 2>/dev/null; sleep 1
node dist/index.cjs > /tmp/gostork-server.log 2>&1 &
sleep 6; lsof -ti:5001 >/dev/null && echo "server up"
ps aux | grep -i "ngrok http" | grep -v grep >/dev/null || \
  (ngrok http --url=polygynous-vergie-coyly.ngrok-free.dev 5001 > /tmp/ngrok.log 2>&1 &)
sleep 4; curl -s https://polygynous-vergie-coyly.ngrok-free.dev/concierge -o /dev/null -w "ngrok: %{http_code}\n"
```

### Database (Supabase)
- Project ID: `bryzqwfzvgjenijciwaa`
- Connection string is in `.env` as `DIRECT_URL` (port 5432). Prompt content is
  in table `ConciergePromptSection` (columns `key`, `content`, `isActive`,
  `updatedAt`).
- **Push a prompt section to the DB** (after editing `ai-prompt-defaults.ts`),
  example for `conversation_flow`:
```bash
node -e '
const fs=require("fs"),{Client}=require("pg");
const c=fs.readFileSync("server/ai-prompt-defaults.ts","utf-8");
const m=c.match(/key: "conversation_flow"[\s\S]*?content: `([\s\S]*?)`,\s*\n\s*\},\s*\n\s*\{[\s\S]*?key: "matching_rules"/);
(async()=>{const cl=new Client({connectionString:process.env.DIRECT_URL});await cl.connect();
const r=await cl.query("UPDATE \"ConciergePromptSection\" SET content=$1,\"updatedAt\"=NOW() WHERE key=$2",[m[1],"conversation_flow"]);
console.log("rows",r.rowCount);await cl.end();})();
' # run with: DIRECT_URL from .env in env
```
  (Prefer the Supabase MCP `execute_sql` if available. If the MCP returns a
  transport error, retry once then ask the user to restart it - do NOT improvise
  other DB access.)

### Git
- Push directly to `main` (project rule - never feature branches).
- **Concurrency warning**: during the prior session, other commits
  (`c051944`, `e55d29a`) landed from another session/the user on the same cost
  feature. Before committing, `git pull --rebase` and check for overlap.

---

## 5. TEST PLAN (run these in order)

Open the app at `https://polygynous-vergie-coyly.ngrok-free.dev`, logged in as a
parent (or admin to set up). **Always start a FRESH concierge session** for each
conversation test (old sessions cache old prompts / state).

### Test 1 - Admin link persists (Part 3)  [prerequisite]
The Bioética→Inser link is currently set (was set via SQL because of a save bug
that is now FIXED). Re-verify the UI save now persists:
1. Admin → Providers → **Bioética & Derecho** → Profile tab.
2. Scroll to **Partner IVF Clinics** (its own card, above "Parents Matching
   Requirements"). Confirm **Inser** shows as a chip.
3. Remove it (X), Save, reload → confirm it's gone. Re-add via search ("inse" →
   click Inser), Save, reload → confirm it persists.
   - ✅ Pass: the chip survives reload (proves the `partnerProviderIds` schema
     fix works).

### Test 2 - Early country gate (Part 1)
1. Fresh session. Make clear you need BOTH a clinic and a surrogate, e.g. first
   message: **"I need an IVF clinic and a surrogate"**.
2. Answer the biological baseline questions (embryos / egg source / etc.).
3. When Phase 3 begins:
   - ✅ Pass: AI delivers international education + **"which countries are you
     open to?"** with `[[MULTI_SELECT:USA|Mexico|Colombia]]` BEFORE any clinic
     question (age / first-IVF / priorities).
   - ❌ Fail: AI asks "how old are you?" / "is this your first IVF?" first.

### Test 3 - Combined agency+clinic reject (Part 2)
Best discriminating scenario uses the age divergence (Mexico clinic max 45,
Colombia clinic max 55). Run a parent **age 50**, hoping for twins, select
**both Mexico and Colombia**:
| Country | Expected | Why |
|---------|----------|-----|
| Mexico (Eggspecting) | ❌ Rejected; AI explains the clinic's max age is 45 | parent 50 > 45 |
| Colombia (Bioética+Inser) | ✅ Offered | Inser allows up to 55 |
- Under 45 → both offered. Over 55 → both rejected.
- Also: a parent whose citizenship is **Italy** → both rejected (agency
  `citizensNotAllowed`).

### Test 4 - Merged country cost card (Part 4)
1. Fresh session, go through to country selection, pick **Colombia**, proceed to
   matching ("ready").
2. ✅ Pass (Colombia): a **CountryProgram** card renders with:
   - Header: 🇨🇴 **Colombia**
   - Combined total ≈ **$80,290**
   - Breakdown: "Surrogacy via Bioética & Derecho" (~$49,490) + "IVF via Inser"
     (~$30,800)
   - "Book Consultation" button.
3. ✅ Pass (Mexico): select Mexico → card headed 🇲🇽 **Mexico**, combined total
   ≈ **$99,900**, single breakdown line "IVF + Surrogacy via Eggspecting"
   (Eggspecting is both agency and clinic, so one combined program). This is the
   apples-to-apples comparison: Mexico $99,900 vs Colombia $80,290.

### Quick API smoke test (no browser; needs a parent JWT)
Mint a 7-day JWT (`{sub:userId,email,roles:["PARENT"]}`, HS256, secret =
`JWT_SECRET` in `.env`) for any parent with `needsSurrogate`/surrogate carrier,
then:
```bash
TOKEN=...; curl -s "http://localhost:5001/api/costs/provider/30a45389-77cd-4188-b7c7-637444576d0e/country-program" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```
Expect `country:"Colombia"`, `combinedMinTotal:80290`, two `components`,
`hasCost:true`.

---

## 6. Known issues / follow-ups (NOT yet done)

1. **Inser's IVF programs are over-tagged with `"surrogacy"`** in `serviceTypes`
   (and Eggspecting's combined program is correctly tagged `[ivf_clinic,
   surrogacy]`). Role-aware combining handles the over-tag, but a clinic
   shouldn't carry the surrogacy tag - consider cleaning the data.
2. **Concurrency**: another session was committing the same feature. Reconcile
   `main` (`git pull --rebase`) before large edits.
3. The Bioética→Inser link was originally set via SQL; Test 1 re-verifies the now
   -fixed UI save path.
4. **Country-label edge case**: the endpoint derives `country` from the matched
   program's `country` field; if a provider ever has zero priced programs it
   falls back to the agency's location state (which can be a US mailing state).
   The chat card prefers the parent's D1 selection (`card.country`), so the
   header stays correct regardless. Both Mexico and Colombia now have priced
   programs, so this is not currently hit.

---

## 7. Bugs fixed in the prior session (context, all on `main`)

- D1 country selection wasn't saved (no `[[SAVE]]`); CURATION summary defaulted to
  "USA" even when Mexico/Colombia was picked. Fixed with explicit D1 save +
  mandatory country acknowledgment + concrete CURATION examples.
- Partner-clinic picker: wrong API path (`/api/admin/providers/...` →
  `/api/providers/by-type/ivf-clinic`); flat list of hundreds → search-to-add
  chips; dropdown clipped by `Card`'s `overflow-hidden` → rendered inline.
- **`partnerProviderIds` missing from `insertProviderSchema`** → `.parse()`
  silently stripped it on save, so the link never persisted. Added to schema.
- Combined cost undercounted (clinic's "surrogacy" over-tag dropped the agency
  fee) → role-aware combining. Country read from program, not location.

---

## 8. Key files

| Path | What |
|------|------|
| `server/ai-prompt-defaults.ts` | Prompt seed; PATH A, EARLY COUNTRY GATE, matching_rules. Push edits to DB. |
| `server/src/mcp-server.ts` | `search_surrogacy_agencies` (returns `partnerClinics[]` + reject-check instructions), `get_cost_ranges`, `resolve_match_card` |
| `server/src/modules/costs/costs.service.ts` | `getCombinedCountryProgramCost` (Part 4 combiner), `getProviderParentPrograms` (reused matcher) |
| `server/src/modules/costs/costs.controller.ts` | `GET provider/:agencyId/country-program` |
| `server/src/modules/providers/providers.controller.ts` | `@Put(":id")` provider update (`insertProviderSchema.partial().parse`), `GET by-type/ivf-clinic` |
| `shared/schema.ts` | `insertProviderSchema` (now includes `partnerProviderIds`) |
| `client/src/pages/admin-provider-edit-page.tsx` | Partner IVF Clinics picker (search + chips) |
| `client/src/pages/concierge-chat-page.tsx` | `CountryProgramCard`, `MatchCardComponent` dispatch, `MatchCard` interface |
| `prisma/schema.prisma` | `Provider.partnerProviderIds`, surrogacy/ivf matching fields, `CostProgram` |

---

## 9. Project rules to respect (from CLAUDE.md)

- Push directly to `main`; never feature branches.
- After ANY code change, run `npm run build` yourself; restart server+ngrok for
  server/prisma changes; never tell the user to build/restart.
- No em-dashes anywhere (use `-`).
- No dialogs/modals; full pages or inline sections.
- Use brand CSS variables, not hardcoded colors.
- Fix root causes; never paper over with fabricated fallbacks.
- AI prompt changes: edit `ai-prompt-defaults.ts` AND push to the DB
  `ConciergePromptSection` (the DB is source of truth at runtime).
