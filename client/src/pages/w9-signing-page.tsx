import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PandaDocSigningShell, useInAppBack } from "@/components/pandadoc-signing-shell";

// formLabel = "W-9" | "W-8BEN-E": the page serves both IRS forms, so every
// bit of copy names the one this row actually is.
type W9SigningSessionResponse =
  | { isCompletedView: true; status: string; w9Id: string; providerId: string; formLabel?: string }
  | { isCompletedView: false; signingUrl: string; w9Id: string; providerId: string; formLabel?: string };

export default function W9SigningPage() {
  // Two routes, one page: /w9/:id (auth-guarded, in-app) and /sign-w9/:token
  // (PUBLIC guest link from the request email - the signer usually has no
  // GoStork account yet).
  const { id: w9Id, token } = useParams<{ id?: string; token?: string }>();
  const isGuest = !!token && !w9Id;
  const queryClient = useQueryClient();

  const sessionUrl = isGuest ? `/api/public/w9/${token}/session` : `/api/w9/${w9Id}/signing-session`;
  const downloadUrl = isGuest ? `/api/public/w9/${token}/download` : `/api/w9/${w9Id}/download`;

  const { data, isLoading, error } = useQuery<W9SigningSessionResponse>({
    queryKey: [sessionUrl],
    queryFn: async () => {
      const res = await fetch(sessionUrl, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load the tax form" }));
        throw new Error(err.message || "Failed to load the tax form");
      }
      return res.json();
    },
    enabled: !!(w9Id || token),
    retry: false,
  });

  const isCompleted = data?.isCompletedView === true;
  const formLabel = data?.formLabel || "tax form";

  const back = useInAppBack(() => "/account/billing");
  function handleBack() {
    // Refresh the Billing tab's W-9 status (and any consumer that reads
    // /w9 endpoints) so the user immediately sees "Completed" after signing
    // instead of the cached "Awaiting your signature" state. Covers both
    // provider mode (/api/provider/w9) and admin mode
    // (/api/admin/providers/:id/w9) without having to know which one this
    // session is in.
    queryClient.invalidateQueries({
      predicate: q =>
        Array.isArray(q.queryKey) &&
        q.queryKey.some(k => typeof k === "string" && k.includes("/w9")),
    });
    // Also refresh the Home work queue - the "Complete your W-9 form" task
    // closes server-side (webhook or read-time reconcile) and must not sit
    // on screen after the user just signed.
    queryClient.invalidateQueries({ queryKey: ["/api/provider/tasks"] });
    queryClient.invalidateQueries({ queryKey: ["/api/provider/dashboard-queue"] });
    back();
  }

  return (
    <PandaDocSigningShell
      title={isCompleted ? `Signed ${formLabel}` : `Complete ${formLabel}`}
      onBack={isGuest ? undefined : handleBack}
      downloadUrl={isCompleted ? downloadUrl : null}
      isLoading={isLoading}
      loadingLabel="Loading tax form..."
      error={error as Error | null}
      errorTitle="Could not load the tax form"
      signedPdfUrl={isCompleted ? downloadUrl : null}
      signingUrl={data && !data.isCompletedView ? data.signingUrl : null}
      // Guest signers have no app to bounce back to - flip to the signed view
      // instead. Logged-in signers go back where they started.
      onSigned={() => (isGuest ? queryClient.invalidateQueries({ queryKey: [sessionUrl] }) : handleBack())}
    />
  );
}
