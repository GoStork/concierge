import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, AlertCircle, Download, Baby } from "lucide-react";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";

type W9SigningSessionResponse =
  | { isCompletedView: true; status: string; w9Id: string; providerId: string }
  | { isCompletedView: false; signingUrl: string; w9Id: string; providerId: string };

export default function W9SigningPage() {
  const { id: w9Id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: brand } = useBrandSettings();

  const { data, isLoading, error } = useQuery<W9SigningSessionResponse>({
    queryKey: ["/api/w9", w9Id, "signing-session"],
    queryFn: async () => {
      const res = await fetch(`/api/w9/${w9Id}/signing-session`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load W-9" }));
        throw new Error(err.message || "Failed to load W-9");
      }
      return res.json();
    },
    enabled: !!w9Id,
    retry: false,
  });

  const isCompleted = data?.isCompletedView === true;
  const logoSrc = brand?.logoUrl ? (getPhotoSrc(brand.logoUrl) || brand.logoUrl) : null;
  const companyName = brand?.companyName || "GoStork";

  // Back action: try history first; if none (e.g. user opened the email link
  // directly in a new tab), fall back to their billing tab.
  function handleBack() {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/account/billing");
    }
  }

  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      {/* Unified header - same for both entry points (billing tab + email link). */}
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-card shrink-0">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5 shrink-0">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>

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
          {isCompleted ? "Signed W-9" : "Complete W-9"}
        </span>

        {isCompleted && (
          <a
            href={`/api/w9/${w9Id}/download`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1.5 text-sm font-medium text-[hsl(var(--primary))] hover:underline shrink-0"
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
            <p className="text-sm text-muted-foreground">Loading W-9...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <p className="text-sm font-medium">Could not load the W-9</p>
            <p className="text-xs text-muted-foreground max-w-sm">{(error as Error).message}</p>
            <Button variant="outline" size="sm" onClick={handleBack}>
              Go Back
            </Button>
          </div>
        )}

        {/* Completed - render signed PDF inline */}
        {isCompleted && (
          <iframe
            src={`/api/w9/${w9Id}/download`}
            className="w-full h-full border-0"
            title="Signed W-9"
          />
        )}

        {/* Signing iframe */}
        {data && !data.isCompletedView && data.signingUrl && (
          <iframe
            src={data.signingUrl}
            className="w-full h-full border-0"
            title="Complete W-9"
            allow="camera; microphone; fullscreen; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
