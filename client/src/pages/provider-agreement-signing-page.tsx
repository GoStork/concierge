/**
 * GoStork provider service agreement signing page. ONE component, two routes:
 *  - /provider-agreement/:id    (auth-guarded) - GoStork admin (fills referral
 *    fees, signs first) and logged-in provider signers.
 *  - /sign-agreement/:token     (PUBLIC, no login) - the guest link emailed to
 *    the provider, who signs BEFORE ever logging in (onboarding starts after
 *    the signature). Token-gated server-side; first open is tracked.
 * Embedded PandaDoc session while signable, inline signed PDF once completed.
 */

import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { PandaDocSigningShell, useInAppBack } from "@/components/pandadoc-signing-shell";

type SigningSessionResponse =
  | { isCompletedView: true; status: string; agreementId?: string; providerId?: string; providerName?: string | null }
  | { isCompletedView: false; signingUrl: string; agreementId?: string; providerId?: string; forGoStork?: boolean; providerName?: string | null };

export default function ProviderAgreementSigningPage() {
  const { id, token } = useParams<{ id?: string; token?: string }>();
  const isGuest = !!token && !id;
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const isGoStorkAdmin = !!(user as any)?.roles?.includes?.("GOSTORK_ADMIN");
  const companyName = brand?.companyName || "GoStork";

  const sessionUrl = isGuest
    ? `/api/public/provider-agreements/${token}/session`
    : `/api/provider-agreements/${id}/signing-session`;
  const downloadUrl = isGuest
    ? `/api/public/provider-agreements/${token}/download`
    : `/api/provider-agreements/${id}/download`;

  const { data, isLoading, error } = useQuery<SigningSessionResponse>({
    queryKey: [sessionUrl],
    queryFn: async () => {
      const res = await fetch(sessionUrl, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load agreement" }));
        throw new Error(err.message || "Failed to load agreement");
      }
      return res.json();
    },
    enabled: !!(id || token),
    retry: false,
  });

  const isCompleted = data?.isCompletedView === true;

  // Admins live on the Agreements tab; providers keep their copy on Legal Identity.
  const back = useInAppBack(() => (isGoStorkAdmin ? "/account/documents" : "/account/legal-identity"));
  function handleBack() {
    // Refresh every consumer of provider-agreement state so statuses flip
    // immediately after signing instead of showing the cached ones.
    queryClient.invalidateQueries({
      predicate: q =>
        Array.isArray(q.queryKey) &&
        q.queryKey.some(k => typeof k === "string" && k.includes("provider-agreement")),
    });
    back();
  }

  return (
    <PandaDocSigningShell
      title={isCompleted ? "Signed Agreement" : "Sign Agreement"}
      onBack={isGuest ? undefined : handleBack}
      downloadUrl={isCompleted ? downloadUrl : null}
      isLoading={isLoading}
      loadingLabel="Loading agreement..."
      error={error as Error | null}
      errorTitle="Could not load the agreement"
      banner={
        isCompleted && isGuest ? (
          <div className="flex items-center justify-center gap-2 px-4 py-3 text-sm border-b bg-[hsl(var(--brand-success)/0.08)] shrink-0" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Thank you - your agreement is signed. {companyName} will be in touch with your next steps; you can download your copy above.
          </div>
        ) : null
      }
      signedPdfUrl={isCompleted ? downloadUrl : null}
      signingUrl={data && !data.isCompletedView ? data.signingUrl : null}
      // The guest has no app to return to, so they get the inline thank-you
      // (the refetch flips to the completed view). Logged-in signers go back.
      onSigned={() => (isGuest ? queryClient.invalidateQueries({ queryKey: [sessionUrl] }) : handleBack())}
    />
  );
}
