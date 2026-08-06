/**
 * Chrome for the parent record page.
 *
 * The record renders from ONE tree for both a GoStork admin and a provider.
 * Role differences are conditional blocks and boolean props inside that tree,
 * never a branch at the top - a top-level branch is how the two surfaces
 * drifted apart in the first place.
 */
import { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ProfileSection } from "@/components/ui/profile-section";
import { ArrowLeft, ChevronDown, ClipboardList, Download, ShieldCheck, Settings, Users, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ParentProfileCard } from "@/components/profile-cards";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import { REASON_LABEL } from "@/components/chat/contact-release-section";
import {
  ContactHiddenChip,
  HouseholdBadge,
  MatchStatusBadge,
  ParentAgreementsCell,
  ParentCostSheetsCell,
  ParentInvoicesCell,
  ServiceChips,
  chatDeepLink,
  dedupeHouseholdPhones,
} from "./parent-cells";
import type { ParentRecord } from "./parent-record-types";

// ─── Collapsible sections, with open state in the URL ───────────────────────

/**
 * Which sections are open lives in ?sec=, not useState, so the browser back
 * button returns to the record exactly as it was left (the same rule the tab
 * state everywhere else in the app follows).
 *
 * The "none" sentinel matters: an empty ?sec= is indistinguishable from "never
 * set", so collapsing everything would silently spring back open on reload.
 */
const SECTIONS_KEY = "gostork-parent-record-sections";

function readSaved(): string[] | null {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (raw === null) return null;
    return raw === "none" ? [] : raw.split(",").filter(Boolean);
  } catch {
    return null;   // private mode
  }
}

/**
 * Which sections are open, in the URL so a link carries the view, and mirrored
 * to localStorage so the choice survives to the next parent you open.
 *
 * Precedence: an explicit ?sec= wins (someone sent you that link), then what
 * you last left the page in, then everything open. Everything open is the
 * default because a record you have to unfold five times is a record you stop
 * reading.
 */
export function useOpenSections(allSections: string[]) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("sec");
  const resolve = (value: string | null): string[] =>
    value === null ? (readSaved() ?? allSections) : value === "none" ? [] : value.split(",").filter(Boolean);

  const open = new Set(resolve(raw));

  const toggle = (id: string, force?: boolean) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const set = new Set(resolve(next.get("sec")));
        const shouldOpen = force ?? !set.has(id);
        if (shouldOpen) set.add(id);
        else set.delete(id);
        const encoded = set.size ? Array.from(set).join(",") : "none";
        try { localStorage.setItem(SECTIONS_KEY, encoded); } catch { /* private mode */ }
        next.set("sec", encoded);
        return next;
      },
      { replace: true },
    );
  };
  return { isOpen: (id: string) => open.has(id), toggle };
}

export function RecordSection({
  id, title, count, open, onToggle, children,
}: {
  id: string;
  title: string;
  count?: number | null;
  open: boolean;
  onToggle: (id: string, force?: boolean) => void;
  children: ReactNode;
}) {
  return (
    // The shared section card every profile detail page uses - its own docs
    // say not to re-implement a section header, and this page had been doing
    // exactly that with a plain bordered div and no header bar.
    <ProfileSection
      title={
        <span className="flex items-center gap-2">
          {title}
          {typeof count === "number" && count > 0 && <span className="t-helper">({count})</span>}
        </span>
      }
      collapsible
      open={open}
      onToggle={() => onToggle(id)}
      contentClassName="p-5"
      data-testid={`section-${id}`}
    >
      {children}
    </ProfileSection>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────

function ContactLine({ record }: { record: ParentRecord }) {
  const members = record.accountMembers.length ? record.accountMembers : [
    {
      id: record.parent.id,
      name: record.parent.name,
      email: (record.parent as any).email ?? null,
      mobileNumber: (record.parent as any).mobileNumber ?? null,
      photoUrl: null,
    },
  ];
  if (!record.contactReleased) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <ContactHiddenChip testId="record-contact-hidden" />
      </div>
    );
  }
  const phones = dedupeHouseholdPhones(members as any, members[0] as any);
  const reason = record.contactReleaseReason as keyof typeof REASON_LABEL | null;
  return (
    <div className="space-y-1">
      {/* Email(s) on one line, phone(s) on their own line below. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {members.filter((m) => m.email).map((m) => (
          <span key={m.id} className="flex items-center gap-1 t-micro-value" data-testid={`record-email-${m.id}`}>
            <span className="t-micro-label">Email</span> {m.email}
            <CopyButton value={m.email as string} testId={`btn-copy-record-email-${m.id}`} />
          </span>
        ))}
      </div>
      {phones.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {phones.map((m: any) => (
            <span key={`p-${m.id}`} className="flex items-center gap-1 t-micro-value" data-testid={`record-phone-${m.id}`}>
              <span className="t-micro-label">Phone</span> {formatPhoneDisplay(m.mobileNumber)}
              <CopyButton value={m.mobileNumber} testId={`btn-copy-record-phone-${m.id}`} />
            </span>
          ))}
        </div>
      )}
      {/* Providers ask "why can I see this now?" constantly, and the payload
          already carries the answer. Phrased exactly as the release panel
          phrases it ("Shared - invoice sent") rather than wrapping the label in
          a sentence: the labels are noun phrases, so "Shared because the
          invoice sent" reads as broken English. */}
      {reason && REASON_LABEL[reason] && (
        <p className="t-helper" data-testid="record-contact-reason">
          Shared - {REASON_LABEL[reason]}
        </p>
      )}
    </div>
  );
}

/**
 * The single Profile block: identity, contact, lead owner, and the profile
 * detail underneath. There used to be two - this card, and a separate "Profile"
 * section repeating the same photo, name, email and phone - which read as two
 * profiles for one person.
 *
 * Collapsing hides the detail but never the identity row or the lead owner, so
 * "who is this and who owns them" survives with the card shut.
 */
export function ParentRecordHeader({
  record, isAdmin, onJumpToCrm, ownerSlot, open = true, onToggle, children,
}: {
  record: ParentRecord;
  isAdmin: boolean;
  onJumpToCrm: () => void;
  /** The lead owner control. Sits in the header bar, so it stays put when the
      card is collapsed. */
  ownerSlot?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  /** The profile detail folded into this card. */
  children?: ReactNode;
}) {
  const photoSrc = record.parent.photoUrl ? getPhotoSrc(record.parent.photoUrl) : null;
  const nextStep = record.crm.followUps[0];

  return (
    <ProfileSection
      title="Profile"
      collapsible
      open={open}
      onToggle={() => onToggle?.()}
      headerActions={ownerSlot}
      contentClassName="p-5 space-y-4"
      data-testid="record-header"
    >
      <div className="flex items-start gap-3 min-w-0">
        {photoSrc ? (
          <img src={photoSrc} alt={record.parent.name || "Parent"} className="w-12 h-12 rounded-[var(--radius)] object-cover object-top shrink-0" />
        ) : (
          <DoctorMonogram name={record.parent.name || "Parent"} size={48} rounded="var(--radius)" />
        )}
        {/* The name is the page title now, so it is not repeated here. */}
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <MatchStatusBadge status={record.matchStatus} />
            <ServiceChips services={record.services} limit={0} testId="record-services" />
            <HouseholdBadge
              memberNames={record.accountMembers.map((m) => m.name || "")}
              selfName={record.parent.name}
              testId="record-household"
            />
          </div>
          <ContactLine record={record} />
        </div>
      </div>

      {/* Read-only mirror of the CRM state, so "what is next" is answerable
          without opening the notes panel. Clicking opens it. */}
      {(nextStep || record.crm.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t">
          {nextStep && (
            <button
              type="button"
              onClick={onJumpToCrm}
              className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
              style={nextStep.overdue
                ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
                : { background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
              data-testid="chip-record-next-step"
            >
              {nextStep.overdue ? "Overdue: " : "Next: "}{nextStep.body}
            </button>
          )}
          {record.crm.tags.slice(0, 3).map((t) => (
            <span
              key={t.id}
              className="text-xs font-ui px-2 py-0.5 rounded-full"
              style={{ background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }}
              data-testid={`chip-record-tag-${t.tagId}`}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}

      {children}
    </ProfileSection>
  );
}

/** Admin-only page actions, rendered beside the page title. */
export function ParentRecordActions({ record }: { record: ParentRecord }) {
  const navigate = useNavigate();
  const newestSession = record.conversations[0]?.sessionId ?? null;
  return (
    <div className="flex items-center gap-2 shrink-0">
      {newestSession && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(chatDeepLink({ sessionId: newestSession }, true) as string)}
          data-testid="btn-record-open-monitor"
        >
          <MessageSquare className="w-3.5 h-3.5 mr-1.5" /> Open in monitor
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(`/users/${record.parent.id}`)}
        data-testid="btn-parent-account-settings"
      >
        <Settings className="w-3.5 h-3.5 mr-1.5" /> Account settings
      </Button>
    </div>
  );
}

// ─── Identity ───────────────────────────────────────────────────────────────

export function ParentIdentitySection({ record }: { record: ParentRecord }) {
  const ip = record.ipForm;
  const submittedButLocked = ip?.status === "SUBMITTED" && !ip.responseId;
  return (
    <div className="space-y-4">
      {record.accountMembers.length > 1 && (
        <div className="rounded-[var(--radius)] border p-4" style={{ background: "hsl(var(--accent) / 0.08)" }} data-testid="record-household-block">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4" style={{ color: "hsl(var(--accent))" }} />
            <span className="text-sm font-medium font-ui">Shared account - {record.accountMembers.length} members</span>
          </div>
          <div className="space-y-2">
            {record.accountMembers.map((m) => (
              <div key={m.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm" data-testid={`household-member-${m.id}`}>
                <span className="font-medium">{m.name || "-"}</span>
                {/* The server nulls these behind Gate B. Rendering them raw
                    printed nothing at all, which reads as broken data. */}
                {m.email
                  ? <span className="text-muted-foreground">{m.email}</span>
                  : <ContactHiddenChip testId={`household-contact-hidden-${m.id}`} />}
                {m.mobileNumber && <span className="text-muted-foreground">{formatPhoneDisplay(m.mobileNumber)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {ip && (
        <div className="rounded-[var(--radius)] border p-4" data-testid="record-ipform">
          <div className="flex items-center gap-2 mb-2">
            <ClipboardList className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium font-ui">Intended Parent Form</span>
          </div>
          {ip.status === "SUBMITTED" && ip.responseId ? (
            <div className="space-y-2">
              <p className="t-helper">
                Submitted{ip.submittedAt ? ` on ${new Date(ip.submittedAt).toLocaleDateString()}` : ""} - download it with your branding.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`/api/provider/ip-forms/${ip.responseId}/pdf?variant=full`, "_blank", "noopener,noreferrer")}
                  data-testid="record-ipform-full"
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" /> Full PDF
                </Button>
                {ip.surrogateAvailable && (
                  <Button
                    size="sm"
                    onClick={() => window.open(`/api/provider/ip-forms/${ip.responseId}/pdf?variant=surrogate`, "_blank", "noopener,noreferrer")}
                    data-testid="record-ipform-surrogate"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Surrogate Version
                  </Button>
                )}
              </div>
            </div>
          ) : submittedButLocked ? (
            // The responseId is withheld behind Gate B. Saying "not submitted
            // yet" here was a flat lie about a form the family did complete.
            <p className="t-helper" data-testid="record-ipform-locked">
              Submitted{ip.submittedAt ? ` on ${new Date(ip.submittedAt).toLocaleDateString()}` : ""}. The PDF unlocks once this
              family shares their contact details with you - sending an invoice or an agreement does it.
            </p>
          ) : (
            <p className="t-helper">
              Not submitted yet
              {ip.surrogateAvailable
                ? " - a match call cannot be scheduled until the family completes and signs their form."
                : " - it becomes available to download here once the family completes and signs it."}
              {ip.promptedAt ? " They have been asked and receive reminders." : ""}
            </p>
          )}
        </div>
      )}

      {/* hideIdentity: the header directly above already shows the photo,
          name, email and phone. Repeating them here is what made the page
          read as two separate Profile blocks. */}
      <ParentProfileCard user={record.parent} layout="wide" hideIdentity testId="record-profile" />
    </div>
  );
}

// ─── Money ──────────────────────────────────────────────────────────────────

export function ParentMoneySection({
  record, showProviderName,
}: { record: ParentRecord; showProviderName: boolean }) {
  const groups = record.money.byProvider;
  if (groups.length === 0) {
    return (
      <div className="rounded-[var(--radius)] bg-secondary p-4">
        <p className="t-helper">No cost sheets, invoices or agreements yet.</p>
      </div>
    );
  }
  const isAdmin = record.viewer.role === "admin";
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.providerId} data-testid={`money-group-${g.providerId}`}>
          {showProviderName && (
            <p className="text-sm font-medium font-ui mb-2">{g.providerName}</p>
          )}
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="t-micro-label mb-1.5">Cost sheets</p>
              {/* No providerName on the rows: an admin already has the group
                  heading above them, and a provider only ever sees their own
                  org, so repeating it on every line is pure noise. */}
              <ParentCostSheetsCell
                costSheets={g.costSheets}
                sessionId={null}
                isAdmin={isAdmin}
                parentUserId={record.parent.id}
                limit={0}
                layout="list"
                testId={`money-costsheets-${g.providerId}`}
              />
            </div>
            <div>
              <p className="t-micro-label mb-1.5">Invoices</p>
              <ParentInvoicesCell
                invoices={g.invoices}
                limit={0}
                layout="list"
                testId={`money-invoices-${g.providerId}`}
              />
            </div>
            <div>
              <p className="t-micro-label mb-1.5">Agreements</p>
              <ParentAgreementsCell
                agreements={g.agreements}
                limit={0}
                layout="list"
                testId={`money-agreements-${g.providerId}`}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
