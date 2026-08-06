import React from "react";

/**
 * Root ErrorBoundary. Without this, any uncaught render exception in a leaf
 * component (e.g. CountryProgramCard, a match card, a chat message render)
 * blanks the whole React tree with no visible feedback. The user just sees
 * a white page and we get no console hint without DevTools open beforehand.
 *
 * On catch we log the full error + stack to the console (so the next time
 * the user opens DevTools they get a usable trace) and render a small
 * "Something went wrong" panel with a Reload button and the raw error
 * message. Uses the brand CSS variables per project rules.
 */
type State = { error: Error | null; info: { componentStack?: string | null } | null };

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log a structured group so it shows up clearly in the browser console.
    // eslint-disable-next-line no-console
    console.group("%c[ErrorBoundary] caught render error", "color:#b00;font-weight:bold");
    // eslint-disable-next-line no-console
    console.error(error);
    if (info?.componentStack) {
      // eslint-disable-next-line no-console
      console.error("Component stack:", info.componentStack);
    }
    // eslint-disable-next-line no-console
    console.groupEnd();
    this.setState({ info });

    // Fire-and-forget: ship the error to the server so we can find it in
    // /tmp/gostork-server.log even if the user never opens DevTools.
    try {
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: error?.message || String(error),
          stack: error?.stack || null,
          componentStack: info?.componentStack || null,
          url: window.location.href,
          userAgent: navigator.userAgent,
          at: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch {
      // never let the boundary itself throw
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground"
        >
          <div className="max-w-md w-full rounded-[var(--radius)] border border-border bg-card p-6 space-y-4 shadow-sm">
            <div>
              <h2 className="font-heading text-xl text-foreground">Something went wrong</h2>
              <p className="t-helper font-body mt-1">
                The page hit an unexpected error. Reloading usually clears it.
              </p>
            </div>
            <pre className="t-helper font-mono whitespace-pre-wrap break-words rounded bg-muted p-3 max-h-40 overflow-auto">
              {this.state.error.message || String(this.state.error)}
            </pre>
            <div className="flex gap-2">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 h-9 rounded-[var(--radius)] bg-primary text-primary-foreground font-ui text-sm"
              >
                Reload page
              </button>
              <button
                onClick={() => this.setState({ error: null, info: null })}
                className="h-9 px-4 rounded-[var(--radius)] border border-border bg-background text-foreground font-ui text-sm"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
