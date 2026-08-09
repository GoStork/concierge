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
  ParentAgreementsCell,
  ParentCostSheetsCell,
  ParentInvoicesCell,
  chatDeepLink,
  dedupeHouseholdPhones,
} from "./parent-cells";
import { cn } from "@/lib/utils";
import { useDense } from "./record-density";
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
/**
 * localStorage remembers which sections you CLOSED, not which you left open.
 *
 * It used to store the open list, which meant every section added later was
 * absent from everyone's saved state and therefore rendered collapsed - the
 * "Next step and tags" section shipped closed for anyone who had ever opened
 * this page before. Persisting the exceptions makes a new section open by
 * default, which is what a new section should do.
 *
 * The v1 key is deliberately not migrated: it holds the inverse set, and
 * reading it as closures would collapse everything a person had open.
 */
const CLOSED_KEY = "gostork-parent-record-closed-v2";

function readClosed(): string[] {
  try {
    return (localStorage.getItem(CLOSED_KEY) || "").split(",").filter(Boolean);
  } catch {
    return [];   // private mode
  }
}

/**
 * Which sections are open, in the URL so a link carries the view, and mirrored
 * to localStorage so the choice survives to the next parent you open.
 *
 * Precedence: an explicit ?sec= wins (someone sent you that link), then
 * everything except what you last closed. Everything open is the default
 * because a record you have to unfold five times is a record you stop reading.
 *
 * The "none" sentinel matters in the URL: an empty ?sec= is indistinguishable
 * from "never set", so a shared link with everything collapsed would silently
 * spring open.
 */
export function useOpenSections(allSections: string[]) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("sec");
  const fromSaved = () => {
    const closed = new Set(readClosed());
    return allSections.filter((s) => !closed.has(s));
  };
  const resolve = (value: string | null): string[] =>
    value === null ? fromSaved() : value === "none" ? [] : value.split(",").filter(Boolean);

  const open = new Set(resolve(raw));

  const toggle = (id: string, force?: boolean) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const set = new Set(resolve(next.get("sec")));
        const shouldOpen = force ?? !set.has(id);
        if (shouldOpen) set.add(id);
        else set.delete(id);
        // Persist the closures, so a section added in a later release is not
        // born collapsed for everyone who has used this page before.
        try {
          localStorage.setItem(CLOSED_KEY, allSections.filter((s) => !set.has(s)).join(","));
        } catch { /* private mode */ }
        next.set("sec", set.size ? Array.from(set).join(",") : "none");
        return next;
      },
      { replace: true },
    );
  };
  return { isOpen: (id: string) => open.has(id), toggle };
}

export function RecordSection({
  id, title, count, children, frameless = false,
}: {
  id: string;
  title: string;
  count?: number | null;
  children: ReactNode;
  /**
   * Drop the section frame and let the children's own cards sit on the page
   * background, HubSpot style. `true` = below lg only (where the record
   * tabs between columns); `"always"` = every width (the Activity feed,
   * HubSpot's middle column). Only for sections whose children ARE cards -
   * a frameless section around bare text would just look unfinished.
   */
  frameless?: boolean | "always";
}) {
  return (
    // The shared section card every profile detail page uses - its own docs
    // say not to re-implement a section header, and this page had been doing
    // exactly that with a plain bordered div and no header bar.
    // NOT collapsible (by request): these sections are the page, and folding
    // them away just hid content behind an extra tap.
    <ProfileSection
      title={
        <span className="flex items-center gap-2">
          {title}
          {typeof count === "number" && count > 0 && <span className="t-helper">({count})</span>}
        </span>
      }
      frameless={frameless}
      // Tighter below sm for the same reason the page gutter shrinks there:
      // three nested frames were eating a third of a phone's width. Frameless
      // sections drop the padding wherever the frame is gone - the children's
      // own cards land straight on the page background.
      contentClassName={frameless === "always" ? "p-0" : frameless ? "p-0 lg:p-5" : "p-2.5 sm:p-5"}
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
          // min-w-0 + break-all: natan123+cbbbwbb@gmail.com is wider than a
          // 320px column, and without these it ran straight under the copy
          // button instead of wrapping.
          <span key={m.id} className="flex items-baseline gap-1.5 min-w-0 max-w-full t-micro-value" data-testid={`record-email-${m.id}`}>
            <span className="t-micro-label shrink-0">Email</span>
            <span className="min-w-0 truncate" title={m.email as string}>{m.email}</span>
            <span className="self-center shrink-0"><CopyButton value={m.email as string} testId={`btn-copy-record-email-${m.id}`} /></span>
          </span>
        ))}
      </div>
      {phones.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {phones.map((m: any) => (
            <span key={`p-${m.id}`} className="flex items-baseline gap-1.5 min-w-0 max-w-full t-micro-value" data-testid={`record-phone-${m.id}`}>
              <span className="t-micro-label shrink-0">Phone</span>
              <span className="whitespace-nowrap">{formatPhoneDisplay(m.mobileNumber)}</span>
              <span className="self-center shrink-0"><CopyButton value={m.mobileNumber} testId={`btn-copy-record-phone-${m.id}`} /></span>
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
  record, isAdmin, onJumpToCrm, ownerSlot, children,
}: {
  record: ParentRecord;
  isAdmin: boolean;
  onJumpToCrm: () => void;
  /** The lead owner control. Sits in the header bar beside the title. */
  ownerSlot?: ReactNode;
  /** The profile detail folded into this card. */
  children?: ReactNode;
}) {
  const dense = useDense();
  const photoSrc = record.parent.photoUrl ? getPhotoSrc(record.parent.photoUrl) : null;
  const nextStep = record.crm.followUps[0];

  return (
    // NOT collapsible, matching every other record section (by request).
    <ProfileSection
      title="Profile"
      headerActions={ownerSlot}
      denseHeader={dense}
      contentClassName="p-2.5 sm:p-5 space-y-4"
      data-testid="record-header"
    >
      <div className="flex items-start gap-3 min-w-0">
        {photoSrc ? (
          <img src={photoSrc} alt={record.parent.name || "Parent"} className="w-12 h-12 rounded-[var(--radius)] object-cover object-top shrink-0" />
        ) : (
          <DoctorMonogram name={record.parent.name || "Parent"} size={48} rounded="var(--radius)" />
        )}
        <div className="min-w-0 space-y-1">
          {/* The page title also carries the name, but inside the card the
              avatar reads as anonymous without it. */}
          {record.parent.name && (
            <p className="font-heading text-sm truncate" data-testid="record-parent-name">{record.parent.name}</p>
          )}
          <div className="min-w-0 flex items-center gap-2 flex-wrap">
            {/* No status badge here. One most-advanced badge lied whenever
                the family ran two service lines (Handed Off on egg donation
                while surrogacy had just booked its first call), and the real
                per-thread statuses already live on the Interested-profiles
                cards and the Lead Status ladders. A summary that cannot be
                accurate is worse than none. */}
            {/* No ServiceChips here: the profile card's Journey "Interested In"
                row below shows the same interestedServices data. Chips stay in
                the Parents table, where row-scanning justifies them. */}
            <HouseholdBadge
              memberNames={record.accountMembers.map((m) => m.name || "")}
              selfName={record.parent.name}
              testId="record-household"
            />
          </div>
        </div>
      </div>
      {/* Full width, NOT beside the avatar. Sharing the row with a 48px
          avatar left an address 220px when it needed 223, so it broke onto a
          second line three pixels short. */}
      <ContactLine record={record} />

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
  const dense = useDense();
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

      {/* hideIdentity: the header directly above already shows the photo,
          name, email and phone. Repeating them here is what made the page
          read as two separate Profile blocks. */}
      {/* "rail" in the contact column: layout="wide" is a 3-up masonry, which
          in a 320px rail gives three ~100px columns of shredded labels. This
          is the same variant the 288px chat sidebar uses. */}
      <ParentProfileCard user={record.parent} layout={dense ? "rail" : "wide"} hideIdentity testId="record-profile" />
    </div>
  );
}


/**
 * The Intended Parent Form card.
 *
 * Used to sit between the phone number and the location, splitting the
 * family's basic details in half with a bordered card and two download
 * buttons. It is paperwork, so it lives with the rest of the paperwork now -
 * rendered at the top of ParentMoneySection.
 */
export function ParentIpFormCard({ record }: { record: ParentRecord }) {
  const ip = record.ipForm;
  if (!ip) return null;
  const submittedButLocked = ip.status === "SUBMITTED" && !ip.responseId;
  return (
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
  );
}

// ─── Money ──────────────────────────────────────────────────────────────────

export function ParentMoneySection({
  record, showProviderName,
}: { record: ParentRecord; showProviderName: boolean }) {
  const dense = useDense();
  const groups = record.money.byProvider;
  const isAdmin = record.viewer.role === "admin";
  return (
    <div className="space-y-5">
      <ParentIpFormCard record={record} />
      {groups.length === 0 && (
        <div className="rounded-[var(--radius)] bg-secondary p-4">
          <p className="t-helper">No cost sheets, invoices or agreements yet.</p>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.providerId} data-testid={`money-group-${g.providerId}`}>
          {showProviderName && (
            <p className="text-sm font-medium font-ui mb-2">{g.providerName}</p>
          )}
          {/* grid-cols-1 is load-bearing: with no explicit template the
              implicit track is max-content sized, so one long attachment
              name pushed every row past the rail card's edge. minmax(0,1fr)
              pins the track to the container and lets truncate do its job. */}
          <div className={cn("grid grid-cols-1 gap-4", !dense && "md:grid-cols-3")}>
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
