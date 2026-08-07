/**
 * The shape of GET /api/parents/:id/record.
 *
 * One payload feeds both audiences. Everything role-dependent has already been
 * decided on the server - a provider's copy is redacted and scoped before it
 * leaves. The client never filters for privacy, only for display.
 */
import type { SessionUser } from "@/components/chat/chat-types";

export type SubjectKind =
  | "egg-donor" | "surrogate" | "sperm-donor"
  | "clinic" | "agency" | "doctor" | "none";

export type CrmScope = "GOSTORK" | "PROVIDER";

export interface AccountMember {
  id: string;
  name: string | null;
  email: string | null;
  mobileNumber: string | null;
  photoUrl: string | null;
}

export interface IpFormStatus {
  responseId: string | null;
  /** NOT_STARTED | DRAFT | SUBMITTED */
  status: string;
  submittedAt: string | null;
  promptedAt: string | null;
  surrogateAvailable?: boolean;
}

export interface ProviderOrg {
  providerId: string;
  providerName: string;
  logoUrl: string | null;
  matchStatus: string | null;
  contactReleased: boolean;
  contactReleaseReason: string | null;
  lastActivityAt: string | null;
  sessionIds: string[];
}

/** One chat thread about one profile. The unit of the lead pipeline. */
export interface ConversationRow {
  sessionId: string;
  providerId: string | null;
  providerName: string | null;
  providerLogoUrl: string | null;
  subjectKind: SubjectKind;
  subjectProfileId: string | null;
  displayName: string;
  photoUrl: string | null;
  profileStatus: string | null;
  profileUrl: string | null;
  serviceType: string | null;
  matchStatus: string | null;
  rawStatus: string;
  lastMessagePreview: string | null;
  /** Admin only - the server sends null to providers. */
  historySummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedProfileRow {
  profileId: string;
  subjectKind: SubjectKind;
  displayName: string;
  photoUrl: string | null;
  profileStatus: string | null;
  providerId: string | null;
  providerName: string | null;
  savedByUserId: string;
  savedAt: string;
  profileUrl: string | null;
}

export interface CrmNote {
  id: string;
  scope: CrmScope;
  providerId: string | null;
  body: string;
  pinned: boolean;
  authorUserId: string;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmFollowUp {
  id: string;
  scope: CrmScope;
  providerId: string | null;
  body: string;
  dueAt: string;
  status: string;
  overdue: boolean;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdAt?: string;
  createdByUserId?: string | null;
}

export interface CrmOwner {
  id: string;
  scope: CrmScope;
  providerId: string | null;
  ownerUserId: string;
  ownerName: string | null;
  /** Resolved live from the user, not snapshotted - a photo snapshot goes
      stale the first time someone changes theirs. Null falls back to initials. */
  ownerPhotoUrl?: string | null;
}

export interface CrmTag {
  id: string;
  tagId: string;
  scope: CrmScope;
  providerId: string | null;
  label: string;
  colorToken: string;
  /** assignedAt - the activity feed places tags chronologically. */
  createdAt?: string;
  assignedByUserId?: string | null;
}

export interface MoneyGroup {
  providerId: string;
  providerName: string;
  invoices: any[];
  agreements: any[];
  costSheets: any[];
  totals: { quotedCents: number; invoicedCents: number; paidCents: number };
}

/**
 * One enriched timeline entry. `detail` is the object the event refers to,
 * joined server-side - see buildActivity in server/parent-record.ts.
 */
export interface ActivityEntry {
  id: string;
  at: string;
  eventType: string;
  actorRole: string | null;
  providerId: string | null;
  providerName: string | null;
  sessionId: string | null;
  /** The concierge persona this family talks to - see buildActivity. */
  aiName: string | null;
  aiAvatarUrl: string | null;
  detail: ActivityDetail | null;
  /**
   * The service line this entry belongs to via its thread ("surrogacy",
   * "egg_donation", "ivf", "legal"), or null when it cannot be attributed -
   * null entries are always shown regardless of the viewer's scope.
   */
  serviceLine?: string | null;
}

export type ActivityDetail =
  | {
      type: "booking";
      bookingId: string; scheduledAt: string; durationMinutes: number | null;
      status: string; outcome: string | null; meetingType: string;
      meetingSubtype: string | null; meetingUrl: string | null;
      timezone: string | null; notes: string | null;
      /** True only on this booking's most recent event - see buildActivity. */
      isCurrentState?: boolean;
      /** The full row, for the shared InlineBookingNotification widget. */
      booking?: any;
    }
  | {
      type: "message";
      notificationId: string; channel: string; kind: string;
      recipient: string; status: string; sentAt: string | null;
      bookingId: string | null;
      subject: string | null;
      bodyPreview: string | null;
      hasHtml: boolean;
      /** False for messages sent before the content columns existed. */
      contentStored: boolean;
    }
  | { type: "invoice"; invoiceId: string; status: string; amountCents: number | null; dueAt: string | null; paymentUrl: string | null; description: string | null }
  | { type: "agreement"; agreementId: string; status: string; documentUrl: string | null; signerStatus: any }
  | { type: "cost_sheet"; quoteId: string; totalCostCents: number | null; fileUrl: string | null; fileName: string | null; notes: string | null }
  | { type: "review"; reviewId: string; rating: number | null; recommendation: string; bodyText: string | null; providerId: string; memberId: string | null; hasResponse: boolean; responseText: string | null }
  | { type: "whisper"; whisperId: string; question: string; answer: string | null; status: string }
  | { type: "ip_form"; responseId: string; submittedAt: string | null }
  | {
      type: "cost_sheet_card";
      messageId: string; sessionId: string;
      /** The chat line the sheet arrived with, written for THIS viewer. */
      message: string | null;
      /** uiCardData as the chat card consumes it, refreshed from the quote. */
      card: any;
    }
  | {
      type: "attachment";
      messageId: string; sessionId: string;
      /** The chat line the file arrived with, written for THIS viewer. */
      message: string | null;
      senderName: string | null;
      url: string; originalName: string | null; mimeType: string | null;
      size: number | null;
    };

export interface ParentRecord {
  viewer: {
    role: "admin" | "provider";
    providerId: string | null;
    /**
     * The service lines the viewer's coordinator roles cover; null = sees
     * everything (admins, provider admins, cross-subject roles). Drives the
     * record page's default "My services" scope - display only, not access.
     */
    serviceLines?: string[] | null;
  };
  accountKey: string;
  parent: SessionUser;
  accountMembers: AccountMember[];
  ipForm: IpFormStatus;
  gates: {
    showIdentity: boolean;
    showContact: boolean;
    contactReleased: boolean;
    contactReleaseReason: string | null;
  };
  contactReleased: boolean;
  contactReleaseReason: string | null;
  services: string[];
  matchStatus: string | null;
  providerOrgs: ProviderOrg[];
  conversations: ConversationRow[];
  savedProfiles: SavedProfileRow[];
  engagement: {
    impressions: number | null;
    profilesViewed: number | null;
    lastBrowsedAt: string | null;
  };
  activity: ActivityEntry[];
  money: { byProvider: MoneyGroup[] };
  crm: {
    notes: CrmNote[];
    followUps: CrmFollowUp[];
    owners: CrmOwner[];
    tags: CrmTag[];
  };
}

/** Normalized row the shared parents table renders, from either list endpoint. */
export interface ParentTableRow {
  key: string;
  id: string;
  name: string | null;
  email: string | null;
  mobileNumber: string | null;
  photoUrl: string | null;
  members: AccountMember[];
  householdNames?: string[];
  contactReleased: boolean;
  services: string[];
  matchStatus: string | null;
  /**
   * Provider table, per-family rows: one most-advanced status per SERVICE
   * LINE (a handed-off egg-donation journey and a fresh surrogacy
   * consultation are both true). serviceKey null = untyped threads only.
   * Absent/single-entry rows render the plain matchStatus badge.
   */
  serviceStatuses?: { serviceKey: string | null; status: string }[];
  costSheets: any[];
  invoices: any[];
  agreements: any[];
  sessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isDisabled?: boolean;
  owner?: { userId?: string; name: string | null } | null;
  nextStep?: { id: string; body: string; dueAt: string; overdue: boolean } | null;
  tags?: { tagId: string; label: string; colorToken: string }[];
}
