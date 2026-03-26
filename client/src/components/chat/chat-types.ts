/**
 * Shared chat types used by conversations-page (provider chat),
 * admin-concierge-monitor, and extracted sub-components.
 */

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  senderType: string;
  senderName: string | null;
  createdAt: string;
  uiCardType?: string;
  uiCardData?: any;
  deliveredAt?: string | null;
  readAt?: string | null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  photoUrl: string | null;
  city: string | null;
  state: string | null;
  parentAccount?: {
    intendedParentProfile?: {
      journeyStage: string | null;
      eggSource: string | null;
      spermSource: string | null;
      carrier: string | null;
      hasEmbryos: boolean | null;
      embryoCount: number | null;
    } | null;
  } | null;
}

export interface SessionDetail {
  id: string;
  userId: string;
  status: string;
  providerId?: string | null;
  providerJoinedAt?: string | null;
  humanRequested?: boolean;
  humanJoinedAt?: string | null;
  humanAgentId?: string | null;
  user: SessionUser;
  title?: string | null;
  messages: SessionMessage[];
}

export type ViewerRole = "provider" | "admin" | "parent";
