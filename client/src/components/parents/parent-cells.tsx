/**
 * Shared parent-row cells.
 *
 * These started life inside staff-page.tsx, which rendered the only two
 * surfaces that needed them (the admin parents table and the provider parents
 * table). The parent record page at /parents/:id now needs the same money
 * chips, the same match badge and the same "contact is gated" chip, and it
 * must render them from the SAME components - a record that disagreed with the
 * row it was opened from is worse than either alone.
 *
 * The money cells therefore take `limit` and `layout`: a table wants 2 chips
 * and a "+N", a record page wants every item on its own line. One component,
 * two contexts, per the no-fork rule in CLAUDE.md.
 */
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Lock, Users } from "lucide-react";
import { DoctorAvatar, DoctorMonogram } from "@/components/marketplace/doctor-monogram";

export const SERVICE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
};

export const JOURNEY_STATUS_LABELS: Record<string, string> = {
  CONSULTATION_BOOKED: "Call Booked",
  PROVIDER_CONNECTED: "Connected",
  MATCH_CALL: "Match Call",
  MATCHED: "Matched",
  DEPOSIT_PAID: "Invoice Paid",
  AGREEMENT_SIGNED: "Agreement Signed",
  HANDED_OFF: "Handed Off",
};

/** yyyy-mm-dd in LOCAL time (toISOString would shift the day near midnight) */
export function toDateParam(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Distinct phone numbers across a household.
 *
 * Partners frequently share one number, so both the table and the record page
 * dedupe by value rather than by login. Falls back to the row's own number
 * when there is only one member.
 */
export function dedupeHouseholdPhones<T extends { id: string; mobileNumber?: string | null }>(
  members: T[] | null | undefined,
  fallback: T,
): T[] {
  const source = (members?.length || 0) > 1 ? (members as T[]) : [fallback];
  return Array.from(
    new Map(source.filter((m) => m.mobileNumber).map((m) => [m.mobileNumber as string, m])).values(),
  );
}

/**
 * The one place that builds a link into a specific chat thread.
 *
 * Admins must NOT be sent to /chat/:sessionId. That route resolves through
 * ChatSessionRedirect, which calls hasProviderRole(roles) - and GOSTORK_ADMIN
 * is not a provider role (shared/roles.ts keeps the two sets disjoint), so the
 * admin's lookup queries /api/my/chat-sessions, misses, and silently drops them
 * on /chat with the deep link lost. Admins get the monitor instead, which is
 * the surface actually built for reading someone else's thread.
 */
export function chatDeepLink(
  target: { sessionId: string | null; parentUserId?: string | null; subjectProfileId?: string | null },
  isAdmin: boolean,
  msg?: string,
): string | null {
  const { sessionId, parentUserId, subjectProfileId } = target;
  if (!sessionId) return null;
  if (isAdmin) {
    return `/admin/concierge-monitor?sessionId=${sessionId}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}`;
  }
  const q = msg ? `?msg=${encodeURIComponent(msg)}` : "";
  // Canonical entity+subject form skips the redirect round-trip entirely.
  if (parentUserId) return `/chat/${parentUserId}/${subjectProfileId || sessionId}${q}`;
  return `/chat?session=${sessionId}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}`;
}

/**
 * Chip marking a row that belongs to a shared parent account (a couple with two
 * logins). Pass selfName to spell out WHO the partner is ("Couple - Ariel
 * Parent 2") so rows are linkable at a glance even when filters hide the
 * partner's row. Hover shows every member.
 */
export function HouseholdBadge({
  memberNames,
  selfName,
  testId,
}: { memberNames: string[]; selfName?: string | null; testId: string }) {
  if (!memberNames || memberNames.length < 2) return null;
  const others = selfName ? memberNames.filter((n) => n && n !== selfName) : [];
  const label = others.length ? `Couple - ${others.join(" & ")}` : "Couple";
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-[10px] font-ui px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }}
      title={`Shared account: ${memberNames.filter(Boolean).join(", ")}`}
      data-testid={testId}
    >
      <Users className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[120px]">{label}</span>
    </span>
  );
}

/**
 * Stands in for the email and mobile columns until the parent has released
 * their contact details to this provider.
 *
 * Says WHY and says WHAT UNLOCKS IT. A blank cell reads as missing data and
 * generates a support ticket; this reads as a policy, and it tells the provider
 * the thing they can actually act on.
 */
export function ContactHiddenChip({ testId }: { testId: string }) {
  return (
    <span
      data-testid={testId}
      title="GoStork keeps parent contact details private until they share them. Sending an intake form, an invoice or an agreement unlocks them. Message them any time right here in chat."
      className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-ui text-foreground/70 whitespace-nowrap"
    >
      <Lock className="w-3 h-3 shrink-0" />
      Shared after intake or invoice
    </span>
  );
}

/**
 * Service chips with the same 2-visible + "+N" treatment the money cells use.
 * Extracted from two inline copies (the admin table read free-text labels off
 * parents-overview, the provider table read a single enum key off
 * parent-contacts) so both render identically.
 */
export function ServiceChips({
  services,
  limit = 2,
  testId,
}: { services: string[] | null | undefined; limit?: number; testId?: string }) {
  const list = (services || []).filter(Boolean);
  if (list.length === 0) return <span className="t-helper">-</span>;
  const shown = limit > 0 ? list.slice(0, limit) : list;
  const extra = list.length - shown.length;
  return (
    // The width cap and the wrapping belong to the table column, where chips
    // are capped to one or two. limit={0} means "show them all", which is the
    // record page - there the cap made two services stack into two rows in a
    // card 1800px wide.
    <div
      className={`flex gap-1 items-center ${limit > 0 ? "flex-wrap max-w-[170px]" : "flex-nowrap"}`}
      data-testid={testId}
    >
      {shown.map((svc) => (
        <span
          key={svc}
          className="text-xs font-ui px-2 py-0.5 rounded-full"
          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
        >
          {SERVICE_LABELS[svc] || svc}
        </span>
      ))}
      {extra > 0 && (
        <span
          className="text-xs font-ui px-1.5 py-0.5 rounded-full"
          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
          title={list.slice(shown.length).map((s) => SERVICE_LABELS[s] || s).join(", ")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

// ─── Match status badge ─────────────────────────────────────────────────────
//
// Mirrors the chat right-pane "Match Status" pill exactly so providers see
// the same label + color treatment whether they're looking at the chat, the
// Parents table or the parent record.
//   CONSULTATION_BOOKED -> "Call Booked" (success / green)
//   PROVIDER_CONNECTED  -> "Connected"   (success / green)
// ACTIVE (anonymous Q&A) shouldn't reach the table - the server filters it
// out so the agency only sees parents who've actually committed to a
// consultation. Anything unexpected falls through to a neutral pill.
export function MatchStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="t-helper">-</span>;
  // Journey ladder (server derives the most-advanced stage per session):
  // Call Booked -> Connected -> Match Call -> Matched -> Deposit Paid ->
  // Agreement Signed. Early stages green, match milestones accent/primary.
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    CONSULTATION_BOOKED: { label: "Call Booked", bg: "hsl(var(--brand-success) / 0.12)", fg: "hsl(var(--brand-success))" },
    PROVIDER_CONNECTED: { label: "Connected", bg: "hsl(var(--brand-success) / 0.12)", fg: "hsl(var(--brand-success))" },
    MATCH_CALL: { label: "Match Call", bg: "hsl(var(--brand-warning) / 0.15)", fg: "hsl(var(--brand-warning))" },
    MATCHED: { label: "Matched", bg: "hsl(var(--accent) / 0.15)", fg: "hsl(var(--accent))" },
    DEPOSIT_PAID: { label: "Invoice Paid", bg: "hsl(var(--primary) / 0.12)", fg: "hsl(var(--primary))" },
    AGREEMENT_SIGNED: { label: "Agreement Signed", bg: "hsl(var(--primary) / 0.12)", fg: "hsl(var(--primary))" },
    HANDED_OFF: { label: "Handed Off", bg: "hsl(var(--primary) / 0.12)", fg: "hsl(var(--primary))" },
  };
  const entry = map[status];
  if (!entry) {
    return (
      <span
        className="text-xs font-ui px-2 py-0.5 rounded-full"
        style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
      >
        {status}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: entry.bg, color: entry.fg }}
    >
      {entry.label}
    </span>
  );
}

// ─── CRM columns ────────────────────────────────────────────────────────────
//
// One implementation each, rendered by BOTH parents tables. Adding these as
// inline JSX twice would have re-created the fork this module exists to close.

export function OwnerCell({ owner, testId }: { owner?: { name: string | null; photoUrl?: string | null } | null; testId?: string }) {
  if (!owner?.name) {
    return (
      <span
        className="text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap"
        style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
        data-testid={testId}
      >
        Unassigned
      </span>
    );
  }
  const first = owner.name.split(" ")[0];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap" title={owner.name} data-testid={testId}>
      <DoctorAvatar name={owner.name} photoUrl={owner.photoUrl} size={20} rounded="999px" />
      {first}
    </span>
  );
}

export function NextStepCell({
  nextStep, testId,
}: { nextStep?: { body: string; dueAt: string; overdue: boolean } | null; testId?: string }) {
  if (!nextStep) return <span className="t-helper">-</span>;
  const due = new Date(nextStep.dueAt);
  const today = new Date();
  const isToday = due.toDateString() === today.toDateString();
  const label = nextStep.overdue ? "Overdue" : isToday ? "Today" : due.toLocaleDateString();
  const warn = nextStep.overdue || isToday;
  const short = nextStep.body.length > 24 ? `${nextStep.body.slice(0, 24)}...` : nextStep.body;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${nextStep.body} - due ${due.toLocaleDateString()}`} data-testid={testId}>
      <span className="text-sm">{short}</span>
      <span
        className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
        style={warn
          ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
          : { background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
      >
        {nextStep.overdue && <AlertTriangle className="w-3 h-3 shrink-0" />}
        {label}
      </span>
    </span>
  );
}

export function TagsCell({
  tags, limit = 2, testId,
}: { tags?: { tagId: string; label: string; colorToken?: string }[] | null; limit?: number; testId?: string }) {
  const list = tags || [];
  if (list.length === 0) return <span className="t-helper">-</span>;
  const shown = limit > 0 ? list.slice(0, limit) : list;
  const extra = list.length - shown.length;
  return (
    // The width cap and the wrapping belong to the table column, where chips
    // are capped to one or two. limit={0} means "show them all", which is the
    // record page - there the cap made two services stack into two rows in a
    // card 1800px wide.
    <div
      className={`flex gap-1 items-center ${limit > 0 ? "flex-wrap max-w-[170px]" : "flex-nowrap"}`}
      data-testid={testId}
    >
      {shown.map((t) => (
        <span
          key={t.tagId}
          className="text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{ background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }}
        >
          {t.label}
        </span>
      ))}
      {extra > 0 && (
        <span
          className="text-xs font-ui px-1.5 py-0.5 rounded-full"
          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
          title={list.slice(shown.length).map((t) => t.label).join(", ")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

/**
 * Every sortable column, resolved in one place.
 *
 * Both tables previously kept their own switch, and they had already drifted:
 * the provider one answered to "service" while the header sent "services", so
 * that column silently did nothing, and neither answered to email or mobile
 * despite rendering a sort arrow on both. Each view now adapts its own payload
 * into this shape and the comparison lives here.
 *
 * Money columns sort by total value rather than count - "who is the biggest
 * deal" is the question a money column gets asked. Agreements have no amount,
 * so they sort by how many there are. Nulls sink to the bottom via sortData.
 */
export interface ParentSortSource {
  name?: string | null;
  email?: string | null;
  mobile?: string | null;
  services?: string[] | null;
  matchStatus?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  costSheets?: { totalCostCents?: number | null }[] | null;
  invoices?: { serviceAmount?: number | null }[] | null;
  agreements?: unknown[] | null;
  owner?: { name?: string | null } | null;
  nextStep?: { dueAt: string } | null;
  tags?: { label: string }[] | null;
}

export function parentSortValue(key: string, src: ParentSortSource): string | number | null {
  const sum = (list: any[] | null | undefined, field: string) =>
    (list?.length ? list.reduce((n, r) => n + (Number(r?.[field]) || 0), 0) : null);
  switch (key) {
    case "name": return (src.name || "").toLowerCase();
    case "email": return (src.email || "").toLowerCase();
    case "mobile": return src.mobile || "";
    case "services": return (src.services || []).map((s) => SERVICE_LABELS[s] || s).sort().join(", ");
    case "status": return src.matchStatus || "";
    case "created": return src.createdAt ? new Date(src.createdAt).getTime() : null;
    case "updated": return src.updatedAt ? new Date(src.updatedAt).getTime() : null;
    case "costSheets": return sum(src.costSheets, "totalCostCents");
    case "invoices": return sum(src.invoices, "serviceAmount");
    case "agreements": return src.agreements?.length || null;
    case "owner": return src.owner?.name || null;
    case "nextDue": return src.nextStep?.dueAt ? new Date(src.nextStep.dueAt).getTime() : null;
    case "tags": return src.tags?.length ? src.tags.map((t) => t.label).sort().join(", ") : null;
    default: return null;
  }
}

/**
 * Service and status filters accept several values at once, carried in the URL
 * as a comma list so a multi-pick view still survives a reload and a bookmark.
 * An empty selection means "no filter", never "match nothing".
 */
export const parseMulti = (raw: string | null): string[] =>
  (raw || "").split(",").map((s) => s.trim()).filter(Boolean);

export const matchesMulti = (selected: string[], value: string | null | undefined) =>
  selected.length === 0 || (!!value && selected.includes(value));

export const matchesMultiAny = (selected: string[], values: string[] | null | undefined) =>
  selected.length === 0 || (values || []).some((v) => selected.includes(v));

/**
 * The CRM filter predicates, shared by both parents tables.
 *
 * Written once so "overdue" cannot come to mean two different things depending
 * on which table you are looking at. `viewerUserId` powers the "My leads"
 * shortcut without the caller needing to know how ownership is stored.
 */
export function matchesCrmFilters(
  row: {
    owner?: { userId?: string; name?: string | null } | null;
    nextStep?: { dueAt: string; overdue: boolean } | null;
    tags?: { label: string }[] | null;
  },
  filters: { owner: string; next: string; tag: string },
  viewerUserId?: string | null,
): boolean {
  if (filters.owner !== "all") {
    if (filters.owner === "unassigned") {
      if (row.owner) return false;
    } else if (filters.owner === "me") {
      if (!row.owner || row.owner.userId !== viewerUserId) return false;
    } else if (row.owner?.userId !== filters.owner) {
      return false;
    }
  }

  if (filters.next !== "all") {
    const step = row.nextStep;
    if (filters.next === "none") {
      if (step) return false;
    } else {
      if (!step) return false;
      if (filters.next === "overdue" && !step.overdue) return false;
      if (filters.next === "today") {
        const due = new Date(step.dueAt);
        if (due.toDateString() !== new Date().toDateString()) return false;
      }
      if (filters.next === "week") {
        const due = new Date(step.dueAt).getTime();
        const weekOut = Date.now() + 7 * 24 * 60 * 60 * 1000;
        if (due > weekOut) return false;
      }
    }
  }

  if (filters.tag !== "all") {
    if (!(row.tags || []).some((t) => t.label === filters.tag)) return false;
  }

  return true;
}

/** Shared shape for the money cells: chips in a table, one row per item on a record. */
export type MoneyCellLayout = "chips" | "list";

interface MoneyCellBase {
  /** Max items before collapsing into "+N". 0 means no cap (record page). */
  limit?: number;
  layout?: MoneyCellLayout;
  testId?: string;
}

function OverflowChip({ count, title }: { count: number; title: string }) {
  return (
    <span
      className="text-xs font-ui px-1.5 py-0.5 rounded-full"
      style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
      title={title}
    >
      +{count}
    </span>
  );
}

function moneyWrapClass(layout: MoneyCellLayout): string {
  return layout === "list" ? "flex flex-col gap-1.5 items-start" : "flex flex-nowrap gap-1.5 items-center";
}

// ─── Invoices cell ──────────────────────────────────────────────────────────
//
// Each invoice is a clickable chip that opens the provider-side invoice
// document. The backend chooses what to serve:
//   - PAID    -> the receipt PDF that was emailed to parent + agency
//   - UNPAID  -> a branded HTML document styled like the payment-request
//                email body (no payment buttons - provider is just viewing).
// Real <a target="_blank"> so cmd-click / middle-click opens in a new tab
// without leaving the list.
export function ParentInvoicesCell({
  invoices,
  limit = 2,
  layout = "chips",
  providerName,
  testId,
}: MoneyCellBase & { invoices: any[]; providerName?: string | null }) {
  if (!invoices || invoices.length === 0) {
    return <span className="t-helper">-</span>;
  }
  const shown = limit > 0 ? invoices.slice(0, limit) : invoices;
  const extra = invoices.length - shown.length;
  return (
    <div className={moneyWrapClass(layout)} data-testid={testId}>
      {shown.map((inv) => {
        const isPaid = inv.status === "PAID";
        const isAwaiting = inv.status === "AWAITING_PAYMENT" || inv.status === "PAYMENT_PROCESSING";
        const tone = isPaid ? "success" : isAwaiting ? "warning" : "muted";
        const bg =
          tone === "success" ? "hsl(var(--brand-success) / 0.12)"
          : tone === "warning" ? "hsl(var(--brand-warning) / 0.15)"
          : "hsl(var(--secondary))";
        const fg =
          tone === "success" ? "hsl(var(--brand-success))"
          : tone === "warning" ? "hsl(var(--brand-warning))"
          : "hsl(var(--foreground))";
        const amount = `$${(inv.serviceAmount / 100).toLocaleString()}`;
        return (
          <a
            key={inv.id}
            href={`/api/provider/invoices/${inv.id}/document`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-ui px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
            style={{ background: bg, color: fg }}
            title={`${inv.serviceType?.replace(/_/g, " ")} - ${amount} - ${inv.status}${isPaid ? " (opens receipt PDF)" : " (opens invoice document)"}`}
          >
            {layout === "list"
              ? `${amount} - ${inv.status.replace(/_/g, " ").toLowerCase()}${providerName ? ` - ${providerName}` : ""}${inv.createdAt ? ` - ${new Date(inv.createdAt).toLocaleDateString()}` : ""}`
              : amount}
          </a>
        );
      })}
      {extra > 0 && (
        <OverflowChip
          count={extra}
          title={invoices.slice(shown.length).map((inv) => `$${(inv.serviceAmount / 100).toLocaleString()} - ${inv.status}`).join("\n")}
        />
      )}
    </div>
  );
}

// ─── Cost sheets cell ───────────────────────────────────────────────────────
//
// One chip per cost sheet on the session, colored by state. Click deep-links
// into the chat scrolled to that cost-sheet card (?msg=quote:<id>) - through
// chatDeepLink, so an admin lands on the monitor rather than being dropped on
// /chat by the provider-only redirect.
export function ParentCostSheetsCell({
  costSheets,
  sessionId,
  isAdmin = false,
  parentUserId,
  limit = 2,
  layout = "chips",
  providerName,
  testId,
}: MoneyCellBase & {
  costSheets: any[];
  sessionId: string | null;
  isAdmin?: boolean;
  parentUserId?: string | null;
  providerName?: string | null;
}) {
  const navigate = useNavigate();
  if (!costSheets || costSheets.length === 0) {
    return <span className="t-helper">-</span>;
  }
  const shown = limit > 0 ? costSheets.slice(0, limit) : costSheets;
  const extra = costSheets.length - shown.length;
  return (
    <div className={moneyWrapClass(layout)} data-testid={testId}>
      {shown.map((cs) => {
        const superseded = !!cs.supersededAt;
        const acked = !superseded && !!cs.parentAcknowledgedAt;
        const bg = acked ? "hsl(var(--brand-success) / 0.12)"
          : superseded ? "hsl(var(--secondary))"
          : "hsl(var(--brand-warning) / 0.15)";
        const fg = acked ? "hsl(var(--brand-success))"
          : superseded ? "hsl(var(--muted-foreground))"
          : "hsl(var(--brand-warning))";
        const amount = `$${((cs.totalCostCents || 0) / 100).toLocaleString()}`;
        const state = superseded ? "Superseded" : acked ? "Acknowledged" : "Awaiting review";
        return (
          <button
            key={cs.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const href = chatDeepLink(
                { sessionId: cs.sessionId || sessionId, parentUserId, subjectProfileId: null },
                isAdmin,
                `quote:${cs.id}`,
              );
              if (href) navigate(href);
            }}
            className="text-xs font-ui px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
            style={{ background: bg, color: fg, opacity: superseded ? 0.75 : 1 }}
            title={`${state} - ${new Date(cs.createdAt).toLocaleDateString()}`}
          >
            {layout === "list"
              ? `${amount} - ${state.toLowerCase()}${providerName ? ` - ${providerName}` : ""} - ${new Date(cs.createdAt).toLocaleDateString()}`
              : amount}
          </button>
        );
      })}
      {extra > 0 && (
        <OverflowChip
          count={extra}
          title={costSheets.slice(shown.length).map((cs) => `$${((cs.totalCostCents || 0) / 100).toLocaleString()}${cs.supersededAt ? " (superseded)" : ""}`).join("\n")}
        />
      )}
    </div>
  );
}

// ─── Agreements cell ────────────────────────────────────────────────────────
//
// One chip per agreement on the session, colored by signing state. Click
// opens the agreement page in a new tab without leaving the list.
export function ParentAgreementsCell({
  agreements,
  limit = 2,
  layout = "chips",
  providerName,
  testId,
}: MoneyCellBase & { agreements: any[]; providerName?: string | null }) {
  if (!agreements || agreements.length === 0) {
    return <span className="t-helper">-</span>;
  }
  const shown = limit > 0 ? agreements.slice(0, limit) : agreements;
  const extra = agreements.length - shown.length;
  return (
    <div className={moneyWrapClass(layout)} data-testid={testId}>
      {shown.map((agr) => {
        const isSigned = agr.status === "SIGNED";
        const isSent = agr.status === "SENT";
        const bg = isSigned
          ? "hsl(var(--brand-success) / 0.12)"
          : isSent ? "hsl(var(--brand-warning) / 0.15)"
          : "hsl(var(--secondary))";
        const fg = isSigned
          ? "hsl(var(--brand-success))"
          : isSent ? "hsl(var(--brand-warning))"
          : "hsl(var(--foreground))";
        const label = isSigned ? "Signed" : isSent ? "Awaiting" : agr.status.charAt(0) + agr.status.slice(1).toLowerCase();
        return (
          <a
            key={agr.id}
            href={`/agreements/${agr.id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-ui px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
            style={{ background: bg, color: fg }}
            title={`${agr.documentType} - ${agr.status}`}
          >
            {layout === "list"
              ? `${label} - ${(agr.documentType || "").replace(/_/g, " ")}${providerName ? ` - ${providerName}` : ""}${agr.createdAt ? ` - ${new Date(agr.createdAt).toLocaleDateString()}` : ""}`
              : label}
          </a>
        );
      })}
      {extra > 0 && (
        <OverflowChip
          count={extra}
          title={agreements.slice(shown.length).map((agr) => `${agr.documentType} - ${agr.status}`).join("\n")}
        />
      )}
    </div>
  );
}
