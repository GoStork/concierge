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
}

export interface CrmOwner {
  id: string;
  scope: CrmScope;
  providerId: string | null;
  ownerUserId: string;
  ownerName: string | null;
}

export interface CrmTag {
  id: string;
  tagId: string;
  scope: CrmScope;
  providerId: string | null;
  label: string;
  colorToken: string;
}

export interface MoneyGroup {
  providerId: string;
  providerName: string;
  invoices: any[];
  agreements: any[];
  costSheets: any[];
  totals: { quotedCents: number; invoicedCents: number; paidCents: number };
}

export interface ParentRecord {
  viewer: { role: "admin" | "provider"; providerId: string | null };
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
