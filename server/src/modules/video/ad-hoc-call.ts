/**
 * Who is hosting an ad-hoc ("start a video call now") call, and how the call
 * is labelled.
 *
 * THE TRAP this exists for: a parent's PRIVATE Eva thread can carry a
 * providerId (a whisper stamps it there - see the chat-session-routing notes).
 * When GoStork staff start a call from that thread, the old code labelled the
 * booking "Ad-hoc Video Call - <that clinic>" and posted the invite as that
 * clinic (senderType "provider"), although the host was GoStork. The host was
 * already correct (staff always host as themselves); only the label and the
 * sender identity leaked the thread's tag.
 */
export type AdHocSenderType = "human" | "provider" | "parent";

export interface AdHocCallIdentity {
  subject: string;
  senderType: AdHocSenderType;
  /** True when GoStork staff host - the call belongs to GoStork, not a clinic. */
  hostedByGoStork: boolean;
}

export function adHocCallIdentity(input: {
  callerActsAsProvider: boolean;
  callerIsStaff: boolean;
  callerProviderId: string | null | undefined;
  sessionProviderId: string | null | undefined;
  sessionProviderName: string | null | undefined;
}): AdHocCallIdentity {
  const { callerActsAsProvider, callerIsStaff, callerProviderId, sessionProviderId, sessionProviderName } = input;

  if (!callerActsAsProvider) {
    // A parent asking the thread's provider for a call: label it with that provider.
    return {
      subject: `Ad-hoc Video Call${sessionProviderName ? ` - ${sessionProviderName}` : ""}`,
      senderType: "parent",
      hostedByGoStork: false,
    };
  }

  // Staff host as GoStork unless they genuinely belong to the thread's provider.
  const hostedByGoStork =
    callerIsStaff && (!sessionProviderId || callerProviderId !== sessionProviderId);

  if (hostedByGoStork) {
    return { subject: "Ad-hoc Video Call - GoStork", senderType: "human", hostedByGoStork: true };
  }
  return {
    subject: `Ad-hoc Video Call${sessionProviderName ? ` - ${sessionProviderName}` : ""}`,
    senderType: "provider",
    hostedByGoStork: false,
  };
}
