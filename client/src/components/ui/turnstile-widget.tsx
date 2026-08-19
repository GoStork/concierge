import { useEffect, useRef, useState } from "react";

/**
 * Cloudflare Turnstile widget for the signup phone step.
 *
 * Fetches the public site key from /api/auth/turnstile-config. When it is
 * configured, the widget renders and hands a fresh token up via onToken; that
 * token rides along on the send-otp request and is verified server-side. When
 * the site key is absent (Turnstile not set up), this renders nothing and the
 * signup flow is unchanged - so it is inert until the keys are added, matching
 * the server's env-gated verifyTurnstile().
 *
 * Tokens are single-use and expire (~5 min), so the parent bumps `resetSignal`
 * after each send-otp attempt to mint a fresh one for a possible resend.
 *
 * appearance:"interaction-only" - the widget draws NOTHING for the (large)
 * majority of visitors that Cloudflare clears from browser signals alone, and
 * only paints the "Verify you are human" checkbox for the ones it actually
 * wants an interaction from. That keeps the signup phone step visually light
 * without the failure mode of a fully invisible widget, where a legitimate
 * visitor on a hardened browser or VPN gets silently refused with nothing on
 * screen to retry. This is a render-time parameter, so the site key stays in
 * Managed mode - no Cloudflare dashboard change is involved.
 *
 * Consequence for callers: on the happy path there is no visible widget and no
 * user action, so the token can still be in flight when the user taps the
 * submit button. The parent MUST wait for the token rather than posting null -
 * send-otp rejects a missing token with a hard 400.
 */

declare global {
  interface Window {
    turnstile?: any;
    __turnstileScriptPromise?: Promise<void>;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (window.__turnstileScriptPromise) return window.__turnstileScriptPromise;
  window.__turnstileScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Turnstile"));
    document.head.appendChild(s);
  });
  return window.__turnstileScriptPromise;
}

interface TurnstileWidgetProps {
  onToken: (token: string | null) => void;
  onEnabledChange?: (enabled: boolean) => void;
  /** Bump to force a fresh token (tokens are single-use). */
  resetSignal?: number;
}

export function TurnstileWidget({ onToken, onEnabledChange, resetSignal = 0 }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Discover whether Turnstile is configured.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/turnstile-config", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const key = d?.siteKey || null;
        setSiteKey(key);
        onEnabledChange?.(!!key);
      })
      .catch(() => {
        if (!cancelled) onEnabledChange?.(false);
      });
    return () => { cancelled = true; };
    // onEnabledChange intentionally omitted - it is a stable setter in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render the widget once the site key is known.
  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          appearance: "interaction-only",
          callback: (token: string) => onToken(token),
          "expired-callback": () => {
            onToken(null);
            if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
          },
          "error-callback": () => onToken(null),
        });
        setLoaded(true);
      })
      .catch(() => onToken(null));
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already gone */ }
      }
      widgetIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  // Reset to a fresh token when the parent asks (after each send attempt).
  useEffect(() => {
    if (resetSignal > 0 && widgetIdRef.current && window.turnstile) {
      onToken(null);
      window.turnstile.reset(widgetIdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="flex justify-center" data-loaded={loaded} />;
}
