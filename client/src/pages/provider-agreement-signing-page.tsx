/**
 * GoStork provider service agreement signing page. ONE component, two routes:
 *  - /provider-agreement/:id    (auth-guarded) - GoStork admin (fills referral
 *    fees, signs first) and logged-in provider signers.
 *  - /sign-agreement/:token     (PUBLIC, no login) - the guest link emailed to
 *    the provider, who signs BEFORE ever logging in (onboarding starts after
 *    the signature). Token-gated server-side; first open is tracked.
 * Embedded PandaDoc session while signable, inline signed PDF once completed.
 */

import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, AlertCircle, Download, Baby, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";

type SigningSessionResponse =
  | { isCompletedView: true; status: string; agreementId?: string; providerId?: string; providerName?: string | null }
  | { isCompletedView: false; signingUrl: string; agreementId?: string; providerId?: string; forGoStork?: boolean; providerName?: string | null };

export default function ProviderAgreementSigningPage() {
  const { id, token } = useParams<{ id?: string; token?: string }>();
  const isGuest = !!token && !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const isGoStorkAdmin = !!(user as any)?.roles?.includes?.("GOSTORK_ADMIN");

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
  const logoSrc = brand?.logoUrl ? (getPhotoSrc(brand.logoUrl) || brand.logoUrl) : null;
  const companyName = brand?.companyName || "GoStork";

  function handleBack() {
    // Refresh every consumer of provider-agreement state so statuses flip
    // immediately after signing instead of showing the cached ones.
    queryClient.invalidateQueries({
      predicate: q =>
        Array.isArray(q.queryKey) &&
        q.queryKey.some(k => typeof k === "string" && k.includes("provider-agreement")),
    });
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      // Admins live on the Agreements tab; providers keep their copy on Legal Identity.
      navigate(isGoStorkAdmin ? "/account/documents" : "/account/legal-identity");
    }
  }

  // When the signer clicks Finish, PandaDoc's embedded session posts a
  // session_view.document.completed message. Logged-in signers bounce back to
  // where they started; the guest has no app to return to, so they get an
  // inline thank-you instead (via refetch flipping to the completed view).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const t = typeof e.data === "string" ? e.data : String((e.data as any)?.type || (e.data as any)?.event || "");
      if (t.includes("session_view.document.completed")) {
        if (isGuest) {
          setTimeout(() => queryClient.invalidateQueries({ queryKey: [sessionUrl] }), 1500);
        } else {
          // Give PandaDoc's own "document completed" confirmation a beat to
          // render so the transition doesn't feel like an error.
          setTimeout(() => handleBack(), 1500);
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // handleBack closes over stable refs; re-binding per render is harmless
    // but pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGoStorkAdmin, isGuest, sessionUrl]);

  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-card shrink-0">
        {!isGuest && (
          <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5 shrink-0">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        )}

        <div className="flex items-center gap-2 min-w-0">
          {logoSrc ? (
            <img src={logoSrc} alt="" className="w-8 h-8 rounded-[var(--radius)] object-contain shrink-0" />
          ) : (
            <div className="w-8 h-8 rounded-[var(--radius)] bg-primary flex items-center justify-center text-primary-foreground shrink-0">
              <Baby className="w-4 h-4" />
            </div>
          )}
          <span className="font-display font-heading text-base text-primary truncate hidden sm:inline" style={{ color: "hsl(var(--primary))" }}>
            {companyName}
          </span>
        </div>

        <div className="h-6 w-px bg-border mx-1 hidden sm:block" />

        <span className="text-sm font-medium truncate">
          {isCompleted ? "Signed Agreement" : "Sign Agreement"}
        </span>

        {isCompleted && (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1.5 text-sm font-medium text-[hsl(var(--primary))] hover:underline shrink-0"
          >
            <Download className="w-4 h-4" />
            Download
          </a>
        )}
      </div>

      <div className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="t-helper">Loading agreement...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <p className="text-sm font-medium">Could not load the agreement</p>
            <p className="t-helper max-w-sm">{(error as Error).message}</p>
            {!isGuest && (
              <Button variant="outline" size="sm" onClick={handleBack}>
                Go Back
              </Button>
            )}
          </div>
        )}

        {isCompleted && isGuest && (
          <div className="flex items-center justify-center gap-2 px-4 py-3 text-sm border-b bg-[hsl(var(--brand-success)/0.08)]" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Thank you - your agreement is signed. {companyName} will be in touch with your next steps; you can download your copy above.
          </div>
        )}

        {isCompleted && (
          <iframe
            src={downloadUrl}
            className={`w-full border-0 ${isGuest ? "h-[calc(100%-2.75rem)]" : "h-full"}`}
            title="Signed Agreement"
          />
        )}

        {data && !data.isCompletedView && data.signingUrl && (
          <iframe
            src={data.signingUrl}
            className="w-full h-full border-0"
            title="Sign Agreement"
            allow="camera; microphone; fullscreen; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
