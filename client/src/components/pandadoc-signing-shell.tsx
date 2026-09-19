/**
 * The ONE full-page shell for every embedded PandaDoc signature: the parent's
 * agreement (/agreements/:id), the provider W-9 (/w9/:id, /sign-w9/:token) and
 * the GoStork provider service agreement (/provider-agreement/:id,
 * /sign-agreement/:token).
 *
 * Those three pages used to carry their own copy of this markup and drifted:
 * only two of them reacted to PandaDoc's "document completed" message, so a
 * parent who signed was left on PandaDoc's confirmation screen; two of them
 * decided "is there a page behind us?" with window.history.length, which is
 * also true when the tab visited another website first, so Back could leave
 * GoStork; and none checked who sent the "completed" message. Page-specific
 * behaviour (which endpoint, where Back goes, what to refresh after signing)
 * stays in each page; everything a signer sees lives here.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, AlertCircle, Download, Baby } from "lucide-react";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getBrandAssetSrc } from "@/lib/profile-utils";

/** PandaDoc serves embedded sessions from these origins (the SDK uses both). */
function isPandaDocOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "pandadoc.com" || host.endsWith(".pandadoc.com") || host === "pandadoc.eu" || host.endsWith(".pandadoc.eu");
  } catch {
    return false;
  }
}

/**
 * Back that never leaves GoStork. React Router stamps an index on history
 * state: idx > 0 means an in-app page is behind us. Anything else (a fresh
 * tab from an email link, or a tab that came from another website) goes to
 * the page's own fallback instead.
 */
export function useInAppBack(fallback: () => string) {
  const navigate = useNavigate();
  return () => {
    if ((window.history.state?.idx ?? 0) > 0) {
      navigate(-1);
      return;
    }
    navigate(fallback());
  };
}

export interface PandaDocSigningShellProps {
  /** Header label, e.g. "Sign Agreement" or "Signed W-9". */
  title: string;
  /** Omit for guest signers, who have no app to go back to. */
  onBack?: () => void;
  /** Shown as a Download link in the header when the document is signed. */
  downloadUrl?: string | null;
  isLoading: boolean;
  loadingLabel: string;
  error: Error | null;
  errorTitle: string;
  /** Optional strip above the document, e.g. a guest's thank-you. */
  banner?: ReactNode;
  /** Inline signed PDF (our own download endpoint). */
  signedPdfUrl?: string | null;
  /** PandaDoc embedded session URL while the document is still signable. */
  signingUrl?: string | null;
  /** Called once when PandaDoc reports the signer finished. */
  onSigned?: () => void;
}

export function PandaDocSigningShell(props: PandaDocSigningShellProps) {
  const { title, onBack, downloadUrl, isLoading, loadingLabel, error, errorTitle, banner, signedPdfUrl, signingUrl, onSigned } = props;
  const { data: brand } = useBrandSettings();
  const logoSrc = brand?.logoUrl ? (getBrandAssetSrc(brand.logoUrl) || brand.logoUrl) : null;
  const companyName = brand?.companyName || "GoStork";

  // Latest callback without re-binding the listener on every render.
  const onSignedRef = useRef(onSigned);
  onSignedRef.current = onSigned;

  useEffect(() => {
    if (!signingUrl) return;
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function onMessage(e: MessageEvent) {
      // Only PandaDoc may tell us a document was signed. Any other window
      // (an extension, another frame) could post the same string.
      if (!isPandaDocOrigin(e.origin)) return;
      const t = typeof e.data === "string" ? e.data : String((e.data as any)?.type || (e.data as any)?.event || "");
      if (!t.includes("session_view.document.completed") || fired) return;
      // PandaDoc posts each event twice (type and event shapes) - act once.
      fired = true;
      // Give PandaDoc's own "completed" confirmation a beat to render so the
      // transition does not read as an error.
      timer = setTimeout(() => onSignedRef.current?.(), 1500);
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (timer) clearTimeout(timer);
    };
  }, [signingUrl]);

  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-card shrink-0">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 shrink-0">
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

        <span className="text-sm font-medium truncate">{title}</span>

        {downloadUrl && (
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

      <div className="flex-1 relative flex flex-col min-h-0">
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="t-helper">{loadingLabel}</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <p className="text-sm font-medium">{errorTitle}</p>
            <p className="t-helper max-w-sm">{error.message}</p>
            {onBack && (
              <Button variant="outline" size="sm" onClick={onBack}>
                Go Back
              </Button>
            )}
          </div>
        )}

        {banner}

        {signedPdfUrl && (
          <iframe src={signedPdfUrl} className="w-full flex-1 min-h-0 border-0" title={title} />
        )}

        {!signedPdfUrl && signingUrl && (
          <iframe
            src={signingUrl}
            className="w-full flex-1 min-h-0 border-0"
            title={title}
            allow="camera; microphone; fullscreen; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
