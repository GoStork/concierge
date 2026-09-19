import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PandaDocSigningShell, useInAppBack } from "@/components/pandadoc-signing-shell";

type SigningSessionResponse =
  | { isProviderView: true; status: string; agreementId: string; sessionId: string | null; providerId: string }
  | { isProviderView?: false; signingUrl: string; sessionId: string; providerId: string | null; isProviderThread: boolean };

export default function AgreementsSigningPage() {
  const { id: agreementId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<SigningSessionResponse>({
    queryKey: ["/api/agreements", agreementId, "signing-session"],
    queryFn: async () => {
      const res = await fetch(`/api/agreements/${agreementId}/signing-session`, {
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load signing session" }));
        throw new Error(err.message || "Failed to load signing session");
      }
      return res.json();
    },
    enabled: !!agreementId,
    retry: false,
  });

  // Back to wherever the user came from (Home, Agreements, the chat, an email
  // link). Opened directly from an email, fall back to the conversation the
  // agreement belongs to.
  const goBack = useInAppBack(() => {
    if (!data?.sessionId) return "/chat";
    return data.providerId
      ? `/chat/${data.providerId}/${data.sessionId}`
      : `/chat/concierge?session=${data.sessionId}`;
  });

  const isProviderView = data?.isProviderView === true;
  const isSigned = isProviderView && data.status === "SIGNED";

  return (
    <PandaDocSigningShell
      title={isProviderView ? "Agreement" : "Sign Agreement"}
      onBack={goBack}
      downloadUrl={isSigned ? `/api/agreements/${agreementId}/download` : null}
      isLoading={isLoading}
      loadingLabel="Loading agreement..."
      error={error as Error | null}
      errorTitle="Could not load the signing session"
      signedPdfUrl={isProviderView ? `/api/agreements/${agreementId}/download` : null}
      signingUrl={!isProviderView ? data?.signingUrl : null}
      onSigned={() => {
        // The parent just signed: every agreement card and list must stop
        // showing "awaiting your signature" before they land back on it.
        queryClient.invalidateQueries({
          predicate: (q) =>
            Array.isArray(q.queryKey) &&
            q.queryKey.some((k) => typeof k === "string" && k.includes("agreement")),
        });
        goBack();
      }}
    />
  );
}
