/**
 * The parent record at /parents/:id.
 *
 * ONE page for both a GoStork admin and a provider. Before this, an admin
 * clicking a parent landed on the account-admin form (password, calendar link)
 * and could not see the journey a provider could see; the two surfaces had
 * drifted apart with no way to keep them honest. Now both read the same
 * payload and render the same tree, and the admin's extra powers are
 * conditional blocks inside it rather than a separate page.
 *
 * /users/:id still exists for the account-admin job (password, roles,
 * calendars) and is reachable from the Account settings button in the header.
 */
import { useEffect, useMemo } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMediaQuery } from "@/hooks/use-mobile";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { JourneyTimelineCard } from "@/components/journey/journey-timeline-card";
import { ContactReleaseSection } from "@/components/chat/contact-release-section";
import { EvaKnowledgePanel } from "@/components/chat/eva-knowledge-panel";
import {
  DenseColumn,
  ParentActivitySection,
  ParentLeadOwner,
  ParentRecordActions,
  ParentIdentitySection,
  ParentMoneySection,
  ParentRecordHeader,
  RecordSection,
  InterestedProfilesSection,
} from "@/components/parents";
import type { ParentRecord } from "@/components/parents";

/**
 * The three columns, in reading order.
 *
 * On desktop they sit side by side. On a phone there is no room for that, so
 * the same three groups become tabs in the same left-to-right order - one
 * column visible at a time, nothing reordered, nothing rebuilt. Both layouts
 * render ONE tree; the tabs only toggle which column is shown.
 */
const COLUMNS = [
  { key: "contact", label: "Contact" },
  // Its own tab on a phone: inside Activity the twelve-rung ladder pushed
  // the actual feed a full screen down.
  { key: "journey", label: "Lead Status" },
  { key: "activity", label: "Activity" },
  { key: "related", label: "Related" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

export default function ParentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Every section, so the default is "all open" and a saved state can name
  // any of them.
  // Sections stopped being collapsible (Aug 2026) - useOpenSections and the
  // ?sec= param went with them; ?col= (mobile tab) and ?scope= remain.

  // Which column the phone is showing. In the URL per the house rule, so back
  // returns to the tab you were on - and so a link can point at one.
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("col");
  const activeCol: ColumnKey = COLUMNS.some((c) => c.key === rawTab) ? (rawTab as ColumnKey) : "contact";
  const setCol = (key: ColumnKey) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("col", key);
      return next;
    }, { replace: true });

  // Matches the `lg:` the three-column grid uses, so there is one breakpoint
  // on this page rather than two that can disagree.
  const isWide = useMediaQuery("(min-width: 1024px)");

  /** Hidden on a phone unless it is the open tab; always shown from lg up. */
  const colClass = (key: ColumnKey) =>
    cn("space-y-4 min-w-0", activeCol !== key && "hidden lg:block");

  const qc = useQueryClient();
  const { data: record, isLoading, error, dataUpdatedAt } = useQuery<ParentRecord>({
    queryKey: ["/api/parents", id, "record"],
    queryFn: async () => {
      const res = await fetch(`/api/parents/${id}/record`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: "Failed to load parent" }));
        throw new Error(body.message || `Failed to load parent (${res.status})`);
      }
      return res.json();
    },
    enabled: !!id,
    retry: false,
    // The record is a CRM screen staff keep open while the world moves -
    // Eva sends a cost sheet, a parent books a call, a colleague pins a
    // note. Poll rather than SSE: the page already re-renders cleanly from
    // a fresh payload (mutations invalidate this same key), and TanStack
    // pauses the interval automatically while the tab is in the background.
    // Same pattern and cadence family as the conversations page.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  // The few panels that fetch OUTSIDE the record payload would otherwise
  // freeze: the app's global staleTime is Infinity, so without a nudge the
  // admin contact-release block and the owner/tag option lists never see a
  // colleague's change. Ride them on the record poll - invalidation only
  // refetches queries actually mounted on this page.
  useEffect(() => {
    if (!dataUpdatedAt) return;
    qc.invalidateQueries({ queryKey: ["/api/admin/contact-releases"] });
    qc.invalidateQueries({ queryKey: ["/api/parents/crm/owner-options"] });
    qc.invalidateQueries({ queryKey: ["/api/parents/crm/tag-vocabulary"] });
  }, [dataUpdatedAt, qc]);

  const isAdmin = record?.viewer.role === "admin";

  // Service-line scope: ANY viewer - coordinator, provider admin, GoStork
  // admin - can focus the record on one service line (an admin often IS the
  // surrogacy coordinator). Chips render whenever the family spans more than
  // one line. A coordinator with a single lane defaults to it; everyone else
  // defaults to All. Display only - access control stays server-side. In the
  // URL per the house rule, so back keeps the scope.
  const viewerLines = record?.viewer.serviceLines || null;
  /** subjectKind (conversations / saved profiles) -> service line. */
  const kindLine = (k?: string | null): string | null =>
    k === "surrogate" ? "surrogacy"
      : k === "egg-donor" ? "egg_donation"
      : k === "sperm-donor" ? "sperm_donation"
      : k === "doctor" || k === "clinic" ? "ivf"
      : null;
  const LINE_LABELS: Record<string, string> = {
    surrogacy: "Surrogacy",
    egg_donation: "Egg Donation",
    sperm_donation: "Sperm Donation",
    ivf: "IVF",
    legal: "Legal",
  };
  const availableLines = useMemo(() => {
    if (!record) return [] as string[];
    const s = new Set<string>();
    for (const e of record.activity) if (e.serviceLine) s.add(e.serviceLine);
    for (const c of record.conversations) { const l = kindLine(c.subjectKind); if (l) s.add(l); }
    for (const p of record.savedProfiles) { const l = kindLine(p.subjectKind); if (l) s.add(l); }
    return ["surrogacy", "egg_donation", "sperm_donation", "ivf", "legal"].filter((l) => s.has(l));
  }, [record]);
  const defaultLine =
    viewerLines?.length === 1 && availableLines.includes(viewerLines[0]) ? viewerLines[0] : "all";
  const rawScope = params.get("scope");
  const activeLine =
    rawScope && (rawScope === "all" || availableLines.includes(rawScope)) ? rawScope : defaultLine;
  const setActiveLine = (line: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      // The default needs no param; anything else is explicit.
      if (line === defaultLine) next.delete("scope");
      else next.set("scope", line);
      return next;
    }, { replace: true });
  const scopedRecord = useMemo(() => {
    if (!record || activeLine === "all") return record;
    // Anything unattributable (null line) always shows - the scope narrows,
    // it never hides what it cannot place.
    const inLine = (line: string | null) => !line || line === activeLine;
    return {
      ...record,
      activity: record.activity.filter((e) => inLine(e.serviceLine ?? null)),
      conversations: record.conversations.filter((c) => inLine(kindLine(c.subjectKind))),
      savedProfiles: record.savedProfiles.filter((p) => inLine(kindLine(p.subjectKind))),
    };
  }, [record, activeLine]);

  return (
    <div className="flex flex-col min-h-[calc(100dvh-64px)]">
      {/* px-2 below sm: on a phone the page gutter, the section frame and
          the entry-card frame all nest, and 16px per side here left the
          actual content barely 290px wide. The section keeps its own border,
          so the page needs almost no gutter of its own. */}
      <div className="flex-1 px-2 sm:px-4 py-6">
        <div className="w-full space-y-4">
          {/* Same page-title treatment as /parents. This was a 14px label in a
              bar of its own, which read as a breadcrumb rather than the title
              of the page you are on. */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="space-y-2">
              <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5 -ml-2" data-testid="btn-parent-detail-back">
                <ArrowLeft className="w-4 h-4" />
                Back
              </Button>
              <h1 className="font-display t-page-title text-primary" data-testid="text-page-title">
                {record?.parent.name || "Parent record"}
              </h1>
            </div>
            {/* Page-level actions belong beside the page title, the way Add
                Parent sits on /parents - not inside the profile card. */}
            <div className="flex items-center gap-3">
              {/* The service-line scope moved into the Activity actions row
                  (by request) - see the scope prop on ParentActivitySection.
                  Same state, same page-wide effect. */}
              {record && isAdmin && <ParentRecordActions record={record} />}
            </div>
          </div>
          {isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 py-12" data-testid="parent-record-loading">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="t-helper">Loading parent...</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" data-testid="parent-detail-error">
              <AlertCircle className="w-8 h-8 text-destructive" />
              <p className="text-sm font-medium">{(error as Error).message}</p>
              <p className="t-helper max-w-sm">
                You can only view parents you've connected with through a chat session or booking.
              </p>
              {/* A 403 here usually arrives from a stale link, so going "back"
                  just re-lands on the same dead link. */}
              <Button variant="outline" size="sm" onClick={() => navigate("/parents")} data-testid="btn-record-back-to-parents">
                Back to parents
              </Button>
            </div>
          )}

          {record && (
            <>
              {/* Phone only: the three columns as tabs, same order. */}
              <div
                className="lg:hidden flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1"
                role="tablist"
                data-testid="record-column-tabs"
              >
                {COLUMNS.map((c) => {
                  const active = activeCol === c.key;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setCol(c.key)}
                      className={cn(
                        "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-ui border transition-colors",
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          // bg-card + border, not bg-secondary: the cream
                          // chips vanished into the Warm Sand page tint.
                          : "bg-card text-foreground border-border",
                      )}
                      data-testid={`tab-record-${c.key}`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>

              {/* items-start so a short column does not stretch to the height
                  of the tallest one and leave a long empty card. */}
              {/* Contact rail is 384px, not 360: the profile's four
                  "Interested In" service tags need 339px of card interior to
                  sit on ONE line at full size, and 360 left them 21px short. */}
              <div className="grid gap-4 items-start lg:grid-cols-[minmax(0,384px)_minmax(0,1fr)_minmax(0,340px)]">
                {/* ── Full-width band: where this family is in the journey ──
                    Spans all three columns so the twelve rungs get the whole
                    page width and land on ONE row. Inside the middle column it
                    only had ~690px and had to wrap onto four. It is still part
                    of the Activity tab on a phone - same section, hoisted, not
                    duplicated. */}
                <div className={cn("lg:col-span-3", colClass("journey"))} data-testid="record-band-journey">
                  <RecordSection id="journey" title="Lead Status" frameless>
                    {/* No sessionId: the record is the full relationship view,
                        which is exactly what this card's own docs say to omit
                        it for. */}
                    {/* Same surface the Home journey cards sit on, so the
                        ladder does not float on bare white while every other
                        block on the page has a card under it. */}
                    {/* Below lg the cream card gives the ladder its chrome on
                        the sand page (cards-on-background). At lg+ the frame
                        came off (by request) - the rungs sit straight on the
                        page. */}
                    <div className="rounded-[var(--radius)] border bg-secondary/40 p-4 lg:border-0 lg:bg-transparent lg:p-0 lg:rounded-none">
                    <JourneyTimelineCard
                      parentUserId={record.parent.id}
                      providerId={isAdmin ? undefined : record.viewer.providerId || undefined}
                      // The service-line chips scope the ladders too - each
                      // journey carries its serviceLine (bank journeys count
                      // as egg or sperm donation by what the bank sells).
                      serviceLine={activeLine === "all" ? null : activeLine}
                      // The events feed lives in the Activity timeline now,
                      // where it is one card per entry rather than a collapsed
                      // list of one-liners under the ladder.
                      variant="sidebar"
                      // Horizontal only where there is a full page width to
                      // spend. Below lg the rungs would be ~30px apart, so it
                      // stays the vertical ladder it was drawn as.
                      orientation={isWide ? "horizontal" : "vertical"}
                      live
                      testId="record-journey"
                    />
                    </div>
                  </RecordSection>
                </div>

                {/* ── Left: who this family is ───────────────────────────── */}
                <DenseColumn>
                  <div className={colClass("contact")} data-testid="record-col-contact">
                    {/* One Profile block. The identity card and the old
                        "Profile" section rendered the same person twice, so
                        the section is folded in here and ?sec=identity now
                        drives this card. */}
                    <ParentRecordHeader
                      // The scoped copy, so the per-line status badges follow
                      // the service filter (Surrogacy selected -> only the
                      // surrogacy badge). Identity fields are identical on
                      // both copies.
                      record={scopedRecord || record}
                      isAdmin={!!isAdmin}
                      onJumpToCrm={() => setCol("activity")}
                      ownerSlot={<ParentLeadOwner record={record} />}
                    >
                      <ParentIdentitySection record={record} />
                    </ParentRecordHeader>
                  </div>
                </DenseColumn>

                {/* ── Middle: what happened, and what was said about it ──── */}
                <div className={colClass("activity")} data-testid="record-col-activity">
                  {/* One timeline, one card per thing that happened. Notes,
                      next steps and tags are ACTIONS on it rather than
                      sections of their own - writing a note adds an entry
                      here, which is where you would look for it anyway. */}
                  <RecordSection id="crm" title="Activity" frameless="always">
                    <ParentActivitySection
                      record={scopedRecord || record}
                      scope={availableLines.length >= 2
                        ? { lines: availableLines, labels: LINE_LABELS, active: activeLine, onChange: setActiveLine }
                        : undefined}
                    />
                  </RecordSection>
                </div>

                {/* ── Right: everything else attached to this family ─────── */}
                <DenseColumn>
                  <div className={colClass("related")} data-testid="record-col-related">
                    <RecordSection
                      id="interested"
                      title="Interested profiles"
                      count={(scopedRecord || record).conversations.length + (scopedRecord || record).savedProfiles.length}
                      frameless
                    >
                      <InterestedProfilesSection record={scopedRecord || record} groupByProvider={!!isAdmin} />
                    </RecordSection>

                    <RecordSection
                      id="money"
                      title="Documents"
                      count={record.money.byProvider.length}
                      frameless
                    >
                      <ParentMoneySection record={record} showProviderName={!!isAdmin} />
                    </RecordSection>

                    {isAdmin && (
                      <RecordSection id="admin" title="GoStork only">
                        <div className="space-y-2">
                          <p className="t-helper">
                            Contact sharing is per provider org. Unlocking one does not affect the others.
                          </p>
                          {record.providerOrgs.length === 0 ? (
                            <p className="t-helper">This family has no provider relationships yet.</p>
                          ) : (
                            record.providerOrgs.map((org, i) => (
                              <ContactReleaseSection
                                key={org.providerId}
                                providerId={org.providerId}
                                parentAccountId={record.accountKey}
                                heading={`Contact sharing - ${org.providerName}`}
                                divider={i > 0}
                                testId={`contact-release-${org.providerId}`}
                              />
                            ))
                          )}
                          {/* The record is account-scoped, so this gets every
                              session's rolling summary rather than the
                              monitor's single one. historySummary is
                              admin-only on the wire - the server sends null to
                              providers - so this block cannot render for them
                              even if it were mounted. */}
                          <div className="border-t pt-4 mt-4">
                            <EvaKnowledgePanel
                              parentAccountId={record.accountKey}
                              divider={false}
                              sessionSummaries={record.conversations
                                .filter((c) => !!c.historySummary)
                                .map((c) => ({
                                  sessionId: c.sessionId,
                                  label: [c.providerName, c.displayName].filter(Boolean).join(" - ") || "Concierge",
                                  historySummary: c.historySummary as string,
                                }))}
                            />
                          </div>
                        </div>
                      </RecordSection>
                    )}
                  </div>
                </DenseColumn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
