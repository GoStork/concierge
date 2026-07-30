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
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JourneyTimelineCard } from "@/components/journey/journey-timeline-card";
import { ContactReleaseSection } from "@/components/chat/contact-release-section";
import {
  ParentCrmPanel,
  ParentIdentitySection,
  ParentMoneySection,
  ParentRecordHeader,
  RecordSection,
  InterestedProfilesSection,
  useOpenSections,
} from "@/components/parents";
import type { ParentRecord } from "@/components/parents";

export default function ParentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isOpen, toggle } = useOpenSections(["identity", "interested"]);

  const { data: record, isLoading, error } = useQuery<ParentRecord>({
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
  });

  const isAdmin = record?.viewer.role === "admin";

  return (
    <div className="flex flex-col min-h-[calc(100dvh-64px)]">
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-background shrink-0">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5" data-testid="btn-parent-detail-back">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <span className="text-sm font-medium font-ui">Parent record</span>
      </div>

      <div className="flex-1 px-4 py-6">
        <div className="w-full space-y-4">
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
              <ParentRecordHeader record={record} isAdmin={!!isAdmin} onJumpToCrm={() => toggle("crm", true)} />

              <RecordSection id="identity" title="Profile" open={isOpen("identity")} onToggle={toggle}>
                <ParentIdentitySection record={record} />
              </RecordSection>

              <RecordSection
                id="interested"
                title="Interested profiles"
                count={record.conversations.length + record.savedProfiles.length}
                open={isOpen("interested")}
                onToggle={toggle}
              >
                <InterestedProfilesSection record={record} groupByProvider={!!isAdmin} />
              </RecordSection>

              <RecordSection id="journey" title="Journey" open={isOpen("journey")} onToggle={toggle}>
                {/* No sessionId: the record is the full relationship view,
                    which is exactly what this card's own docs say to omit it
                    for. The wrapper is a plain bordered div, never a Card -
                    Card's overflow-hidden clips the timeline. */}
                <JourneyTimelineCard
                  parentUserId={record.parent.id}
                  providerId={isAdmin ? undefined : record.viewer.providerId || undefined}
                  showEvents
                  variant={isAdmin ? "home" : "sidebar"}
                  testId="record-journey"
                />
              </RecordSection>

              <RecordSection
                id="money"
                title="Cost sheets, invoices and agreements"
                count={record.money.byProvider.length}
                open={isOpen("money")}
                onToggle={toggle}
              >
                <ParentMoneySection record={record} showProviderName={!!isAdmin} />
              </RecordSection>

              <RecordSection id="crm" title="Notes and follow-up" open={isOpen("crm")} onToggle={toggle}>
                <ParentCrmPanel record={record} />
              </RecordSection>

              {isAdmin && (
                <RecordSection id="admin" title="GoStork only" open={isOpen("admin")} onToggle={toggle}>
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
                  </div>
                </RecordSection>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
