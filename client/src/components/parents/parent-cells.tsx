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
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Lock, Users } from "lucide-react";
import { DoctorAvatar, DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { CostSheetRow } from "@/components/chat/cost-sheet-row";
import { InvoiceRow } from "@/components/chat/invoice-row";
import { AgreementRow } from "@/components/chat/agreement-row";
import {
  JOURNEY_STAGE_LABELS, LEGACY_MATCH_STATUS_TO_STAGE,
  MATCHED_ELSEWHERE_STAGE, MATCHED_ELSEWHERE_LABEL,
} from "@shared/journey-ladder";
import { ServiceTag, normalizeServiceKey } from "@/components/ui/service-tag";

export const SERVICE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
};

/**
 * A voided invoice is not state anyone acts on: it never becomes money, it
 * should not sit in a money column, and it must not tick "Invoice Sent" on
 * the ladder. EXPIRED is deliberately NOT here - that invoice was really
 * sent and the window simply lapsed, so it stays visible as something to
 * re-send. The server applies the same rule (journey-timeline, the two list
 * endpoints, and the record's invoiced total).
 */
export const isLiveInvoice = (inv: { status?: string | null }) => inv?.status !== "CANCELLED";

/**
 * Any raw service text -> the SERVICE_LABELS enum key.
 *
 * Invoices and agreements store DISPLAY text ("Egg Donation"), sessions store
 * subject types ("Egg Donor"), and this table's vocabulary is the enum key -
 * three spellings of one idea. Routes through the ServiceTag normalizer so
 * there is exactly one place that knows how service names vary.
 */
export function serviceEnumKey(raw: string | null | undefined): string | null {
  switch (normalizeServiceKey(raw)) {
    case "surrogacy": return "SURROGACY";
    case "egg_donation": return "EGG_DONATION";
    case "sperm_donation": return "SPERM_DONATION";
    case "ivf": return "IVF_CLINIC";
    default: return null;
  }
}

/**
 * Status labels come from the shared ladder, so the Match Status column, its
 * filter and the journey timeline cannot drift apart again. The legacy keys
 * stay mapped because older rows and the chat session's own status enum - a
 * different thing, tracking whether a provider may post - still use them.
 */
export const JOURNEY_STATUS_LABELS: Record<string, string> = {
  ...JOURNEY_STAGE_LABELS,
  // A branch outcome rather than a rung, which is why it is not in
  // JOURNEY_STAGE_LABELS - but it does reach this badge, unlike No Show and
  // Canceled, because it becomes the row's current state.
  [MATCHED_ELSEWHERE_STAGE]: MATCHED_ELSEWHERE_LABEL,
  CONSULTATION_BOOKED: JOURNEY_STAGE_LABELS.consult_scheduled,
  PROVIDER_CONNECTED: JOURNEY_STAGE_LABELS.consult_scheduled,
  MATCH_CALL: JOURNEY_STAGE_LABELS.match_call_scheduled,
  MATCHED: JOURNEY_STAGE_LABELS.matched,
  DEPOSIT_PAID: JOURNEY_STAGE_LABELS.invoice_paid,
  AGREEMENT_SIGNED: JOURNEY_STAGE_LABELS.agreement_signed,
  HANDED_OFF: JOURNEY_STAGE_LABELS.handed_off,
};

/** Re-exported so parents callers keep one import; defined in the filter kit. */
export { toDateParam } from "@/components/ui/filter-controls";

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
 * parent-contacts) so both render identically. Each chip is the shared
 * ServiceTag, so this column carries the same per-service color as every
 * other surface on the platform.
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
        <ServiceTag key={svc} service={SERVICE_LABELS[svc] || svc} />
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
  // Keyed on the shared stage ids. Legacy enum values stay mapped so a row
  // written before the ladder was unified still renders a coloured pill
  // instead of falling through to the neutral "unknown" case.
  const TONE = {
    early: { bg: "hsl(var(--brand-success) / 0.12)", fg: "hsl(var(--brand-success))" },
    call: { bg: "hsl(var(--brand-warning) / 0.15)", fg: "hsl(var(--brand-warning))" },
    match: { bg: "hsl(var(--accent) / 0.15)", fg: "hsl(var(--accent))" },
    money: { bg: "hsl(var(--primary) / 0.12)", fg: "hsl(var(--primary))" },
    lost: { bg: "hsl(var(--muted-foreground) / 0.12)", fg: "hsl(var(--muted-foreground))" },
  };
  const toneFor: Record<string, { bg: string; fg: string }> = {
    registered: TONE.early,
    exploring: TONE.early,
    consult_scheduled: TONE.early,
    consult_completed: TONE.early,
    ip_form_submitted: TONE.early,
    // Green like the other on-track stages. Amber is reserved for states
    // that need chasing (and the branch rungs never reach this badge at all
    // - No Show and Canceled live on the ladder and the attention chip, not
    // in the match-status vocabulary).
    doctor_call_scheduled: TONE.early,
    // The one branch outcome that DOES reach this badge: the family committed
    // to another provider on this line. Muted rather than red - it is a closed
    // door, not an error, and nothing here is anyone's fault.
    [MATCHED_ELSEWHERE_STAGE]: TONE.lost,
    doctor_call_completed: TONE.early,
    match_call_scheduled: TONE.call,
    matched: TONE.match,
    invoice_sent: TONE.money,
    invoice_paid: TONE.money,
    agreement_sent: TONE.money,
    agreement_signed: TONE.money,
    handed_off: TONE.money,
  };
  const stage = LEGACY_MATCH_STATUS_TO_STAGE[status] || status;
  const tone = toneFor[stage];
  const label = JOURNEY_STATUS_LABELS[stage] || JOURNEY_STATUS_LABELS[status];
  const map: Record<string, { label: string; bg: string; fg: string }> =
    tone && label ? { [status]: { label, bg: tone.bg, fg: tone.fg } } : {};
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
}: { nextStep?: { title: string; dueAt: string | null; overdue: boolean } | null; testId?: string }) {
  if (!nextStep) return <span className="t-helper">-</span>;
  // A journey-derived step (no explicit task) has no due date - it is a
  // direction, not a deadline. Title only, no date chip.
  if (!nextStep.dueAt) {
    const shortTitle = nextStep.title.length > 24 ? `${nextStep.title.slice(0, 24)}...` : nextStep.title;
    return (
      <span className="inline-flex items-center whitespace-nowrap text-sm" title={nextStep.title} data-testid={testId}>
        {shortTitle}
      </span>
    );
  }
  const due = new Date(nextStep.dueAt);
  const today = new Date();
  const isToday = due.toDateString() === today.toDateString();
  const label = nextStep.overdue ? "Overdue" : isToday ? "Today" : due.toLocaleDateString();
  const warn = nextStep.overdue || isToday;
  const short = nextStep.title.length > 24 ? `${nextStep.title.slice(0, 24)}...` : nextStep.title;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${nextStep.title} - due ${due.toLocaleDateString()}`} data-testid={testId}>
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
  /** Admin-only Provider column: every provider named on any service line. */
  serviceStatuses?: { providerNames?: string[] | null }[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  costSheets?: { totalCostCents?: number | null }[] | null;
  invoices?: { serviceAmount?: number | null }[] | null;
  agreements?: unknown[] | null;
  owner?: { name?: string | null } | null;
  nextStep?: { dueAt: string } | null;
  lastTouchAt?: string | null;
}

/** #5 Silence: whole days since the family's last touch, or null when unknown. */
export function quietDaysOf(lastTouchAt: string | Date | null | undefined): number | null {
  if (!lastTouchAt) return null;
  const t = new Date(lastTouchAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * "Quiet for" cell: days since the last touch the silence sweep saw. Warm
 * amber once it has been a week - the same signal the automation acts on.
 */
export function QuietForCell({ lastTouchAt, testId }: { lastTouchAt?: string | null; testId?: string }) {
  const days = quietDaysOf(lastTouchAt);
  if (days === null) return <span className="t-helper" data-testid={testId}>-</span>;
  const label = days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
  return (
    <span className={days >= 7 ? "text-sm font-ui text-warning" : "t-helper"} data-testid={testId}>
      {label}
    </span>
  );
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
    case "provider": {
      const names = Array.from(new Set((src.serviceStatuses || []).flatMap((s) => s.providerNames || []))).sort();
      return names.length ? names.join(", ") : null;
    }
    case "created": return src.createdAt ? new Date(src.createdAt).getTime() : null;
    case "updated": return src.updatedAt ? new Date(src.updatedAt).getTime() : null;
    case "costSheets": return sum(src.costSheets, "totalCostCents");
    case "invoices": return sum(src.invoices, "serviceAmount");
    case "agreements": return src.agreements?.length || null;
    case "owner": return src.owner?.name || null;
    case "nextDue": return src.nextStep?.dueAt ? new Date(src.nextStep.dueAt).getTime() : null;
    case "quiet": return quietDaysOf(src.lastTouchAt);
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
 * Intended Parent form filter.
 *
 * "Submitted" is the only state that unblocks a match call, so a DRAFT counts
 * as not filled in - same as having no row at all. Both tables ask this the
 * same way.
 */
export function matchesIpForm(filter: string, status: string | null | undefined): boolean {
  if (filter === "all" || !filter) return true;
  if (filter === "submitted") return status === "SUBMITTED";
  // A started-but-unsigned form is its own thing: the family has engaged and
  // needs a nudge, not a first ask. Lumping it in with "never started" hid
  // exactly the group worth chasing.
  if (filter === "draft") return status === "DRAFT";
  return status !== "SUBMITTED";   // not submitted: draft or no form at all
}

export const IP_FORM_FILTER_LABELS: Record<string, string> = {
  submitted: "Form submitted",
  draft: "Form started, not signed",
  missing: "Form not submitted",
};

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
  },
  filters: { owner: string; next: string },
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

  return true;
}

/** Shared shape for the money cells: chips in a table, one row per item on a record. */
export type MoneyCellLayout = "chips" | "list";

interface MoneyCellBase {
  /** Max items before collapsing into "+N". 0 means no cap (record page). */
  limit?: number;
  layout?: MoneyCellLayout;
  /**
   * Line-aligned mode: one row of chips per entry, row N pairing with line N
   * of the table's Services column (an empty line renders "-"). Built by the
   * table via alignToLines; overrides limit/stack when set.
   */
  groups?: any[][] | null;
  testId?: string;
}

/** The groups-mode wrapper all three money cells share. */
function GroupedChipRows({ groups, render, testId }: {
  groups: any[][];
  render: (item: any) => ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1 items-start" data-testid={testId}>
      {groups.map((items, i) => (
        <span key={i} className="flex items-center gap-1 h-[22px]">
          {items.length === 0 ? <span className="t-helper">-</span> : items.map(render)}
        </span>
      ))}
    </div>
  );
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
  stack = false,
  groups = null,
  providerName,
  testId,
}: MoneyCellBase & { invoices: any[]; providerName?: string | null; stack?: boolean }) {
  if (!invoices || invoices.length === 0) {
    return <span className="t-helper">-</span>;
  }
  const shown = limit > 0 ? invoices.slice(0, limit) : invoices;
  const extra = invoices.length - shown.length;

  // In a list - the record's Documents panel - draw the SAME card the chat
  // sidebar draws, receipt/invoice link included. The pill below stays for
  // the table, where a cell has one line of width.
  if (layout === "list") {
    return (
      <div className="space-y-1.5" data-testid={testId}>
        {shown.map((inv) => (
          <InvoiceRow
            key={inv.id}
            invoice={inv}
            documentHref={`/api/provider/invoices/${inv.id}/document`}
            providerName={providerName}
            testId={`invoice-row-${inv.id}`}
          />
        ))}
        {extra > 0 && <OverflowChip count={extra} title={`${extra} more`} />}
      </div>
    );
  }

  const invoiceChip = (inv: any) => {
    const isPaid = inv.status === "PAID";
    const isAwaiting = inv.status === "AWAITING_PAYMENT" || inv.status === "PAYMENT_PROCESSING";
    // Money moving BACKWARD is a red event, not a neutral one - a cream
    // refund chip read the same as an inert draft.
    const isRefund = inv.status === "REFUNDED" || inv.status === "PARTIALLY_REFUNDED";
    const tone = isPaid ? "success" : isAwaiting ? "warning" : isRefund ? "error" : "muted";
    const bg =
      tone === "success" ? "hsl(var(--brand-success) / 0.12)"
      : tone === "warning" ? "hsl(var(--brand-warning) / 0.15)"
      : tone === "error" ? "hsl(var(--brand-error) / 0.12)"
      : "hsl(var(--secondary))";
    const fg =
      tone === "success" ? "hsl(var(--brand-success))"
      : tone === "warning" ? "hsl(var(--brand-warning))"
      : tone === "error" ? "hsl(var(--brand-error))"
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
        {amount}
      </a>
    );
  };

  if (groups) return <GroupedChipRows groups={groups} render={invoiceChip} testId={testId} />;

  return (
    // stack: one invoice per 22px line, so the parents table's invoice
    // column pairs line-for-line with the stacked Services column (invoices
    // arrive pre-sorted into service order by the caller).
    <div
      className={stack ? "flex flex-col gap-1 items-start" : moneyWrapClass(layout)}
      data-testid={testId}
    >
      {shown.map(invoiceChip)}
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
  stack = false,
  groups = null,
  providerName,
  testId,
}: MoneyCellBase & {
  costSheets: any[];
  sessionId: string | null;
  isAdmin?: boolean;
  parentUserId?: string | null;
  providerName?: string | null;
  stack?: boolean;
}) {
  const navigate = useNavigate();
  if (!costSheets || costSheets.length === 0) {
    return <span className="t-helper">-</span>;
  }
  const shown = limit > 0 ? costSheets.slice(0, limit) : costSheets;
  const extra = costSheets.length - shown.length;

  // In a list - the record's Documents panel - draw the SAME card the chat
  // sidebar draws. The pill below is for the table, where a row has one cell
  // of width and an amount is all that fits; in a column with room, showing
  // the same quote as a coloured label made it look like a different object
  // depending on which page you were on.
  if (layout === "list") {
    return (
      <div className="space-y-1.5" data-testid={testId}>
        {shown.map((cs) => (
          <CostSheetRow
            key={cs.id}
            quote={cs}
            sessionId={cs.sessionId || sessionId}
            providerName={providerName}
            testId={`cost-sheet-row-${cs.id}`}
            onOpen={() => {
              const href = chatDeepLink(
                { sessionId: cs.sessionId || sessionId, parentUserId, subjectProfileId: null },
                isAdmin,
                `quote:${cs.id}`,
              );
              if (href) navigate(href);
            }}
          />
        ))}
        {extra > 0 && <OverflowChip count={extra} title={`${extra} more`} />}
      </div>
    );
  }

  const costSheetChip = (cs: any) => {
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
        {/* Chips only now - the list layout returns the shared card above,
            so this is the table's one-cell form: the amount, with the
            state carried by the tint and the tooltip. */}
        {amount}
      </button>
    );
  };

  if (groups) return <GroupedChipRows groups={groups} render={costSheetChip} testId={testId} />;

  return (
    <div className={stack ? "flex flex-col gap-1 items-start" : moneyWrapClass(layout)} data-testid={testId}>
      {shown.map(costSheetChip)}
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
  stack = false,
  groups = null,
  providerName,
  testId,
}: MoneyCellBase & { agreements: any[]; providerName?: string | null; stack?: boolean }) {
  if (!agreements || agreements.length === 0) {
    return <span className="t-helper">-</span>;
  }
  const shown = limit > 0 ? agreements.slice(0, limit) : agreements;
  const extra = agreements.length - shown.length;

  if (layout === "list") {
    return (
      <div className="space-y-1.5" data-testid={testId}>
        {shown.map((agr) => (
          <AgreementRow key={agr.id} agreement={agr} providerName={providerName} testId={`agreement-row-${agr.id}`} />
        ))}
        {extra > 0 && <OverflowChip count={extra} title={`${extra} more`} />}
      </div>
    );
  }

  const agreementChip = (agr: any) => {
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
        {label}
      </a>
    );
  };

  if (groups) return <GroupedChipRows groups={groups} render={agreementChip} testId={testId} />;

  return (
    <div className={stack ? "flex flex-col gap-1 items-start" : moneyWrapClass(layout)} data-testid={testId}>
      {shown.map(agreementChip)}
      {extra > 0 && (
        <OverflowChip
          count={extra}
          title={agreements.slice(shown.length).map((agr) => `${agr.documentType} - ${agr.status}`).join("\n")}
        />
      )}
    </div>
  );
}

/**
 * The framed block an activity card puts its words in.
 *
 * The message cards have always drawn what was actually SAID inside a border,
 * which is what separates the content from the facts about it. Notes and tasks
 * carry words too and were letting them run loose in the card, so the three
 * kinds of card read as three different objects. One box, one look.
 */
export function ActivityBody({ children, className, testId }: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "text-sm break-words rounded-[calc(var(--radius)/2)] bg-card border px-2.5 py-2",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
