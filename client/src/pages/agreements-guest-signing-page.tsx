import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AgreementsGuestSigningPage() {
  const { token } = useParams<{ token: string }>();

  const { data, isLoading, error } = useQuery<{ signingUrl: string }>({
    queryKey: ["/api/agreements/guest", token, "signing-session"],
    queryFn: async () => {
      const res = await fetch(`/api/agreements/guest/${token}/signing-session`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load signing session" }));
        throw new Error(err.message || "Failed to load signing session");
      }
      return res.json();
    },
    enabled: !!token,
    retry: false,
  });

  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      {/* Minimal branded header */}
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-background shrink-0">
        <span className="text-sm font-heading font-semibold" style={{ color: "hsl(var(--primary))" }}>
          GoStork
        </span>
        <span className="text-sm font-medium text-muted-foreground">|</span>
        <span className="text-sm font-medium">Sign Agreement</span>
        {data?.signingUrl && (
          <a
            href={data.signingUrl.replace("?embedded=1", "")}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in new tab
          </a>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Loading your agreement...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <p className="text-sm font-medium">Could not load the signing session</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {(error as Error).message}
            </p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Try Again
            </Button>
          </div>
        )}

        {data?.signingUrl && (
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
