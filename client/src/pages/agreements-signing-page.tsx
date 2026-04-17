import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, AlertCircle, Download } from "lucide-react";

type SigningSessionResponse =
  | { isProviderView: true; status: string; agreementId: string; sessionId: string | null; providerId: string }
  | { isProviderView?: false; signingUrl: string; sessionId: string; providerId: string | null; isProviderThread: boolean };

export default function AgreementsSigningPage() {
  const { id: agreementId } = useParams<{ id: string }>();
  const navigate = useNavigate();

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

  const handleBack = () => {
    if (data?.sessionId) {
      if (!data.isProviderView && data.isProviderThread && data.providerId) {
        navigate(`/chat/${data.providerId}/${data.sessionId}`);
      } else if (data.isProviderView && data.providerId && data.sessionId) {
        navigate(`/chat/${data.providerId}/${data.sessionId}`);
      } else {
        navigate(`/chat/concierge?session=${data.sessionId}`);
      }
    } else {
      navigate(-1);
    }
  };

  const isSigned = data?.isProviderView ? data.status === "SIGNED" : false;

  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      {/* Minimal header */}
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-background shrink-0">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <span className="text-sm font-medium">
          {data?.isProviderView ? "Agreement" : "Sign Agreement"}
        </span>
        {data?.isProviderView && isSigned && (
          <a
            href={`/api/agreements/${agreementId}/download`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1.5 text-sm font-medium text-[hsl(var(--primary))] hover:underline"
          >
            <Download className="w-4 h-4" />
            Download
          </a>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Loading agreement...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <p className="text-sm font-medium">Could not load the signing session</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {(error as Error).message}
            </p>
            <Button variant="outline" size="sm" onClick={handleBack}>
              Go Back
            </Button>
          </div>
        )}

        {/* Provider view - render signed PDF inline */}
        {data?.isProviderView && (
          <iframe
            src={`/api/agreements/${agreementId}/download`}
            className="w-full h-full border-0"
            title="Signed Agreement"
          />
        )}

        {/* Parent view - signing iframe */}
        {!data?.isProviderView && data?.signingUrl && (
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
